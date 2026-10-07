package io.amar.console.data.money

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.sync.SyncBusClient
import io.amar.console.sync.outbox.Outbox
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * `money:category` + `money:rule` end to end over a scripted hub (responses by
 * PATH, never FIFO — HubConfig is process-wide and background pollers share it):
 * optimistic write, the request, the refresh, the heal, the reconcile guards.
 */
@RunWith(RobolectricTestRunner::class)
class MoneyRepositoryCategoryRuleTest {

    private lateinit var db: ConsoleDb
    private lateinit var outbox: Outbox
    private lateinit var repo: MoneyRepository

    private val seen = mutableListOf<Pair<String, String>>()
    private var writeCode = 200
    /** Status for `POST /finance/overrides` alone (null = [writeCode]). */
    private var overrideWriteCode: Int? = null

    // What the hub says — the test moves these to mimic a landed write.
    private var hubCategories = """[
        {"id":"cat_food","name":"Food","emoji":"🍔","color":"#a78bfa","kind":"expense"},
        {"id":"cat_salary","name":"Salary","emoji":"💸","color":"#4ade80","kind":"income","variable":false},
        {"id":"cat_old","name":"Old","emoji":"x","color":"#000000","kind":"expense","archived":true},
        {"id":"cat_transfer","name":"Transfer","emoji":"🔁","color":"#94a3b8","kind":"transfer","isSystem":true}]"""
    private var hubRules = """[
        {"id":"rule_tesco","priority":10,"label":"Tesco","match":{"merchantContains":"tesco"},"categoryId":"cat_food"},
        {"id":"rule_monzo","priority":100,"label":"Monzo: groceries","match":{"monzoCategoryEquals":"groceries"},"categoryId":"cat_food"}]"""
    private var hubBudgets = """[{"id":"bud_1","categoryId":"cat_food","monthlyTargetPence":40000}]"""
    private var hubClasses = """{"tx_1":{"categoryId":"cat_food","ignored":false,"isTransfer":false}}"""

    private val hub = HubClient(
        OkHttpClient.Builder().addInterceptor { chain ->
            val req = chain.request()
            val path = req.url.encodedPath
            val body = req.body?.let { b -> okio.Buffer().also { b.writeTo(it) }.readUtf8() } ?: ""
            seen += "${req.method} $path" to body
            val (code, text) = when {
                req.method != "GET" -> {
                    val c = if (path.endsWith("/finance/overrides")) overrideWriteCode ?: writeCode else writeCode
                    c to (if (c == 200) """{"ok":true}""" else """{"error":"x"}""")
                }
                path.endsWith("/finance/all") -> 200 to """{"categories":$hubCategories,"rules":$hubRules,"budgets":$hubBudgets,
                    "settings":{"emergencyFund":{"mode":"months","months":6}}}"""
                path.endsWith("/finance/budget-status") -> 200 to "[]"
                path.endsWith("/money/transactions") -> 200 to """[{"id":"tx_1","amount":-500,"currency":"GBP","created":"2026-10-01T10:00:00Z","settled":"2026-10-01T10:00:00Z","description":"TESCO","category":"groceries"}]"""
                path.endsWith("/finance/categorise") -> 200 to hubClasses
                path.endsWith("/finance/overrides") -> 200 to "[]"
                path.endsWith("/finance/projection") -> 200 to """{"emergencyFundPence":100,"runway":{}}"""
                path.endsWith("/finance/networth/history") -> 200 to "[]"
                path.endsWith("/money/status") -> 200 to """{"connected":true,"hasCredentials":true,"transactionCount":1}"""
                else -> 404 to """{"error":"nope"}"""
            }
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body(text.toResponseBody("application/json".toMediaType())).build()
        }.build()
    )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), ConsoleDb::class.java).allowMainThreadQueries().build()
        val scope = TestScope()
        outbox = Outbox(ApplicationProvider.getApplicationContext(), scope, db, hub, SyncBusClient(scope), durableScheduler = {})
        repo = MoneyRepository(db, hub, outbox)
        repo.registerOutboxHandlers()
    }

    @After
    fun tearDown() = db.close()

    private fun writes(method: String, suffix: String) = seen.filter { it.first.startsWith(method) && it.first.endsWith(suffix) }
    private fun bodyOf(req: Pair<String, String>) = MoneyJson.json.parseToJsonElement(req.second).jsonObject

    private val food get() = repo.state.value.categories.first { it.id == "cat_food" }

    // ---- reconcile -------------------------------------------------------

    @Test
    fun `reconcile takes categories (archived flagged) and rules in priority order off finance-all`() = runTest {
        repo.reconcile()
        val s = repo.state.value
        assertEquals(listOf("cat_food", "cat_salary", "cat_old", "cat_transfer"), s.categories.map { it.id })
        assertEquals(listOf("cat_food", "cat_salary", "cat_transfer"), s.liveCategories.map { it.id })
        assertFalse(s.categories[1].variable)
        assertEquals(listOf("rule_tesco", "rule_monzo"), s.rules.map { it.id })
        assertEquals("Tesco", MoneyCategories.ruleTitle(s.rules[0]))
        assertTrue(writes("GET", "/finance/rules").isEmpty() && writes("GET", "/finance/categories").isEmpty())
    }

    @Test
    fun `categories and rules survive a restart through the meta cache`() = runTest {
        repo.reconcile()
        val fresh = MoneyRepository(db, hub, outbox)
        fresh.hydrate()
        assertEquals(repo.state.value.categories, fresh.state.value.categories)
        assertEquals(repo.state.value.rules, fresh.state.value.rules)
        assertNull(fresh.state.value.error)
    }

    // ---- categories ------------------------------------------------------

    @Test
    fun `a new category shows at once under its minted id, posts that id, and keeps it after the write`() = runTest {
        repo.reconcile()
        val c = MoneyCategory(MoneyCategories.mintCategoryId(), "Fun", "🎉", "#f472b6", "expense")
        repo.upsertCategory(c)
        assertTrue(repo.state.value.categories.any { it.id == c.id && it.name == "Fun" })

        hubCategories = hubCategories.trimEnd(']') + """,{"id":"${c.id}","name":"Fun","emoji":"🎉","color":"#f472b6","kind":"expense","variable":true}]"""
        outbox.drain()

        val post = writes("POST", "/finance/categories").single()
        assertEquals("\"${c.id}\"", bodyOf(post)["id"].toString())
        assertEquals("\"Fun\"", bodyOf(post)["name"].toString())
        assertTrue(repo.state.value.categories.any { it.id == c.id && !it.archived })
        assertTrue(db.outbox().pending().isEmpty())
        assertEquals(0, db.outbox().inFlightEntityIds(MoneyRepository.TYPE_CATEGORY).size)
    }

    @Test
    fun `editing a category posts the whole record under its id`() = runTest {
        repo.reconcile()
        repo.upsertCategory(food.copy(name = "Groceries", variable = false))
        assertEquals("Groceries", food.name)
        hubCategories = hubCategories.replace("\"name\":\"Food\"", "\"name\":\"Groceries\"")
        outbox.drain()
        val post = writes("POST", "/finance/categories").single()
        assertEquals("\"cat_food\"", bodyOf(post)["id"].toString())
        assertEquals("false", bodyOf(post)["variable"].toString())
        assertEquals("Groceries", food.name)
    }

    @Test
    fun `deleting a category drops its rules and budget now, DELETEs it, then refreshes everything`() = runTest {
        repo.reconcile()
        repo.deleteCategory(food)
        val s = repo.state.value
        assertTrue(s.categories.none { it.id == "cat_food" })
        assertTrue(s.rules.isEmpty()) // both rules pointed at Food
        assertTrue(s.budgets.isEmpty())

        hubCategories = """[{"id":"cat_salary","name":"Salary","emoji":"💸","color":"#4ade80","kind":"income"}]"""
        hubRules = "[]"; hubBudgets = "[]"
        hubClasses = """{"tx_1":{"categoryId":"cat_uncat","ignored":false,"isTransfer":false}}"""
        outbox.drain()

        assertEquals(1, writes("DELETE", "/finance/categories/cat_food").size)
        assertEquals(listOf("cat_salary"), repo.state.value.categories.map { it.id })
        // A rule change re-categorises history: the cached row follows the hub's new verdict.
        assertEquals("cat_uncat", db.money().byId("tx_1")!!.categoryId)
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test(expected = IllegalArgumentException::class)
    fun `a system category is refused before anything is queued`() = runTest {
        repo.reconcile()
        repo.deleteCategory(repo.state.value.categories.first { it.id == "cat_transfer" })
    }

    @Test
    fun `a refused delete heals the category and the rules and budget it took with it`() = runTest {
        repo.reconcile()
        writeCode = 400
        repo.deleteCategory(food)
        assertTrue(repo.state.value.rules.isEmpty())
        outbox.drain()
        val s = repo.state.value
        assertTrue(s.categories.any { it.id == "cat_food" })
        assertEquals(listOf("rule_tesco", "rule_monzo"), s.rules.map { it.id })
        assertEquals(listOf("bud_1"), s.budgets.map { it.id })
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `a rejected create drops the row it added and a rejected edit restores the old record`() = runTest {
        repo.reconcile()
        writeCode = 400
        repo.upsertCategory(MoneyCategory("cat_new1", "Nope", "x", "#000000", "expense"))
        repo.upsertCategory(food.copy(name = "Renamed"))
        assertEquals(5, repo.state.value.categories.size)
        outbox.drain()
        assertEquals(4, repo.state.value.categories.size)
        assertEquals("Food", food.name)
    }

    @Test
    fun `a delete the hub has already applied is still done`() = runTest {
        repo.reconcile()
        writeCode = 404
        repo.deleteCategory(food)
        // 404 = the hub no longer has it, so its lists no longer carry it either.
        hubCategories = """[{"id":"cat_salary","name":"Salary","emoji":"💸","color":"#4ade80","kind":"income"}]"""
        hubRules = "[]"; hubBudgets = "[]"
        outbox.drain()
        assertTrue(db.outbox().pending().isEmpty())
        assertTrue(repo.state.value.categories.none { it.id == "cat_food" })
    }

    @Test
    fun `deleting a category whose create is still queued drops the create and sends one DELETE`() = runTest {
        repo.reconcile()
        val c = MoneyCategory(MoneyCategories.mintCategoryId(), "Fun", "🎉", "#f472b6", "expense")
        repo.upsertCategory(c)
        repo.deleteCategory(c)
        assertTrue(repo.state.value.categories.none { it.id == c.id })
        writeCode = 404 // the hub never had it
        outbox.drain()
        assertTrue(writes("POST", "/finance/categories").isEmpty())
        assertEquals(1, writes("DELETE", "/finance/categories/${c.id}").size)
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `a reconcile does not undo a queued edit, resurrect a queued delete, or revive its cascaded rules`() = runTest {
        repo.reconcile()
        repo.upsertCategory(repo.state.value.categories.first { it.id == "cat_salary" }.copy(name = "Pay"))
        repo.deleteCategory(food)
        repo.reconcile() // the hub still serves its pre-edit copies
        val s = repo.state.value
        assertEquals("Pay", s.categories.first { it.id == "cat_salary" }.name)
        assertTrue(s.categories.none { it.id == "cat_food" })
        assertTrue(s.rules.isEmpty())
        assertTrue(s.budgets.isEmpty())
    }

    // ---- rules -----------------------------------------------------------

    @Test
    fun `a new rule shows in priority order at once, posts without nulls, and keeps its id`() = runTest {
        repo.reconcile()
        val r = MoneyRule(MoneyCategories.mintRuleId(), 50, null, RuleMatch(descriptionContains = "lidl", amountSign = "out"), "cat_food")
        repo.upsertRule(r)
        assertEquals(listOf("rule_tesco", r.id, "rule_monzo"), repo.state.value.rules.map { it.id })

        hubRules = hubRules.trimEnd(']') + """,{"id":"${r.id}","priority":50,"match":{"descriptionContains":"lidl","amountSign":"out"},"categoryId":"cat_food"}]"""
        outbox.drain()

        val post = writes("POST", "/finance/rules").single()
        assertEquals("""{"id":"${r.id}","priority":50,"match":{"descriptionContains":"lidl","amountSign":"out"},"categoryId":"cat_food"}""", post.second)
        assertEquals(listOf("rule_tesco", r.id, "rule_monzo"), repo.state.value.rules.map { it.id })
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `editing a rule sends cleared optionals as null and re-sorts on priority`() = runTest {
        repo.reconcile()
        val tesco = repo.state.value.rules.first { it.id == "rule_tesco" }
        repo.upsertRule(tesco.copy(priority = 200, label = null))
        assertEquals(listOf("rule_monzo", "rule_tesco"), repo.state.value.rules.map { it.id })
        hubRules = """[
            {"id":"rule_monzo","priority":100,"label":"Monzo: groceries","match":{"monzoCategoryEquals":"groceries"},"categoryId":"cat_food"},
            {"id":"rule_tesco","priority":200,"match":{"merchantContains":"tesco"},"categoryId":"cat_food"}]"""
        outbox.drain()
        val body = bodyOf(writes("POST", "/finance/rules").single())
        assertEquals("null", body["label"].toString())
        assertEquals("null", body["sharedFraction"].toString())
        assertEquals("200", body["priority"].toString())
        assertEquals(listOf("rule_monzo", "rule_tesco"), repo.state.value.rules.map { it.id })
    }

    @Test
    fun `deleting a rule drops it now and DELETEs it, and a 404 is still done`() = runTest {
        repo.reconcile()
        writeCode = 404
        repo.deleteRule(repo.state.value.rules.first { it.id == "rule_tesco" })
        assertEquals(listOf("rule_monzo"), repo.state.value.rules.map { it.id })
        hubRules = """[{"id":"rule_monzo","priority":100,"label":"Monzo: groceries","match":{"monzoCategoryEquals":"groceries"},"categoryId":"cat_food"}]"""
        outbox.drain()
        assertEquals(1, writes("DELETE", "/finance/rules/rule_tesco").size)
        assertEquals(listOf("rule_monzo"), repo.state.value.rules.map { it.id })
        assertTrue(db.outbox().pending().isEmpty())
    }

    @Test
    fun `a rejected rule edit heals the old rule back into place`() = runTest {
        repo.reconcile()
        writeCode = 400
        val tesco = repo.state.value.rules.first { it.id == "rule_tesco" }
        repo.upsertRule(tesco.copy(priority = 999))
        assertEquals(listOf("rule_monzo", "rule_tesco"), repo.state.value.rules.map { it.id })
        outbox.drain()
        assertEquals(listOf("rule_tesco", "rule_monzo"), repo.state.value.rules.map { it.id })
        assertEquals(10, repo.state.value.rules[0].priority)
    }

    @Test
    fun `a reconcile does not undo a queued rule edit`() = runTest {
        repo.reconcile()
        val tesco = repo.state.value.rules.first { it.id == "rule_tesco" }
        repo.upsertRule(tesco.copy(label = "Big Tesco"))
        repo.reconcile()
        assertEquals("Big Tesco", repo.state.value.rules.first { it.id == "rule_tesco" }.label)
    }

    @Test
    fun `a landed rule write re-pulls classifications but leaves a queued override alone`() = runTest {
        repo.reconcile()
        assertEquals("cat_food", db.money().byId("tx_1")!!.categoryId)
        // An override of tx_1 is queued but its POST keeps 503ing (Retry, not terminal): the rule refresh must not clobber it.
        overrideWriteCode = 503
        repo.applyOverride("tx_1", OverrideEdit.SetCategory("cat_salary"))
        assertEquals("cat_salary", db.money().byId("tx_1")!!.categoryId)
        hubClasses = """{"tx_1":{"categoryId":"cat_uncat","ignored":false,"isTransfer":false}}"""
        repo.upsertRule(MoneyRule("rule_new1", 1, null, RuleMatch(merchantContains = "zzz"), "cat_food"))
        outbox.drain()
        assertEquals("cat_salary", db.money().byId("tx_1")!!.categoryId)
        assertEquals(listOf("tx_1"), db.outbox().inFlightEntityIds(MoneyRepository.TYPE_OVERRIDE))
    }
}
