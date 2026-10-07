package io.amar.console.data.money

import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Port of the SPA `CategoriesView.tsx` helpers + the `money:category` / `money:rule` outbox contract. */
class MoneyCategoriesTest {

    private val food = MoneyCategory("cat_food", "Food", "🍔", "#a78bfa", "expense")
    private val salary = MoneyCategory("cat_salary", "Salary", "💸", "#4ade80", "income", variable = false)
    private val old = MoneyCategory("cat_old", "Old", "x", "#000000", "expense", archived = true)
    private val transfer = MoneyCategory("cat_transfer", "Transfer", "🔁", "#94a3b8", "transfer", isSystem = true)

    private val tesco = MoneyRule("rule_tesco", 10, "Tesco", RuleMatch(merchantContains = "tesco"), "cat_food")
    private val monzo = MoneyRule("rule_monzo", 100, "Monzo: groceries", RuleMatch(monzoCategoryEquals = "groceries"), "cat_food")
    private val shared = MoneyRule(
        "rule_shared", 20, null, RuleMatch(descriptionContains = "lidl", amountSign = "out"), "cat_food",
        sharedFraction = 0.5, sharedWithCounterparty = "Veronica",
    )

    // ---- ids + colours ---------------------------------------------------

    @Test
    fun `minted ids take the hub's own shape so the hub stores them verbatim`() {
        assertEquals("cat_0123abcd", MoneyCategories.mintCategoryId("0123abcd-ef01-2345-6789-abcdef012345"))
        assertEquals("rule_0123abcd", MoneyCategories.mintRuleId("0123abcd-ef01-2345-6789-abcdef012345"))
        assertTrue(MoneyCategories.mintCategoryId().matches(Regex("cat_[0-9a-f]{8}")))
    }

    @Test
    fun `normaliseHex accepts short, long and bare forms and refuses the rest`() {
        assertEquals("#aabbcc", MoneyCategories.normaliseHex("#ABC"))
        assertEquals("#a78bfa", MoneyCategories.normaliseHex(" a78bfa "))
        assertNull(MoneyCategories.normaliseHex("#a78bf"))
        assertNull(MoneyCategories.normaliseHex("purple"))
    }

    // ---- categories ------------------------------------------------------

    @Test
    fun `grouped follows the SPA order and hides archived unless asked`() {
        val cats = listOf(food, transfer, salary, old)
        assertEquals(
            listOf("income" to listOf("cat_salary"), "expense" to listOf("cat_food"), "transfer" to listOf("cat_transfer")),
            MoneyCategories.grouped(cats, showArchived = false).map { (k, v) -> k to v.map { it.id } },
        )
        assertEquals(listOf("cat_food", "cat_old"), MoneyCategories.grouped(cats, showArchived = true)[1].second.map { it.id })
    }

    @Test
    fun `system categories cannot be deleted — the hub 400s`() {
        assertFalse(MoneyCategories.canDelete(transfer))
        assertTrue(MoneyCategories.canDelete(food))
    }

    @Test
    fun `the category body is the whole record with the id, so the hub's POST upserts by it`() {
        val o = MoneyJson.json.parseToJsonElement(MoneyCategories.categoryBody(salary)).jsonObject
        assertEquals("cat_salary", o["id"].toString().trim('"'))
        assertEquals("false", o["variable"].toString())
        assertEquals("false", o["archived"].toString())
        assertNull(o["isSystem"]) // never claimed by the phone
    }

    @Test
    fun `cascadeOf names the rules and budgets the hub's deleteCategory will drop`() {
        val c = MoneyCategories.cascadeOf("cat_food", listOf(tesco, monzo, shared.copy(categoryId = "cat_x")), listOf(Budget("b1", "cat_food", 1), Budget("b2", "cat_x", 2)))
        assertEquals(listOf("rule_tesco", "rule_monzo"), c.rules.map { it.id })
        assertEquals(listOf("b1"), c.budgets.map { it.id })
    }

    @Test
    fun `withInFlightCategories keeps a queued edit and a queued delete over the hub's copy`() {
        val hub = listOf(food, salary)
        val local = listOf(food.copy(name = "Groceries")) // salary deleted locally, food renamed
        val out = MoneyCategories.withInFlightCategories(hub, local, setOf("cat_food", "cat_salary"))
        assertEquals(listOf("Groceries"), out.map { it.name })
        assertEquals(hub, MoneyCategories.withInFlightCategories(hub, local, emptySet()))
    }

    @Test
    fun `withInFlightRules drops the rules of a category whose delete is queued`() {
        val hub = listOf(tesco, monzo, shared.copy(categoryId = "cat_x"))
        val deleting = MoneyCategories.deletingCategoryIds(setOf("cat_food"), local = listOf(salary))
        assertEquals(setOf("cat_food"), deleting)
        val out = MoneyCategories.withInFlightRules(hub, emptyList(), emptySet(), deleting)
        assertEquals(listOf("rule_shared"), out.map { it.id })
        // The category still present locally is an edit, not a delete.
        assertTrue(MoneyCategories.deletingCategoryIds(setOf("cat_food"), listOf(food)).isEmpty())
    }

    @Test
    fun `withInFlightRules lays a queued rule edit back and re-sorts by priority`() {
        val hub = listOf(tesco, monzo)
        val local = listOf(monzo.copy(priority = 5))
        assertEquals(listOf("rule_monzo", "rule_tesco"), MoneyCategories.withInFlightRules(hub, local, setOf("rule_monzo")).map { it.id })
    }

    // ---- rules -----------------------------------------------------------

    @Test
    fun `describeMatch matches the SPA wording`() {
        assertEquals("(empty)", MoneyCategories.describeMatch(RuleMatch()))
        assertEquals("merchant ~ \"tesco\"", MoneyCategories.describeMatch(RuleMatch(merchantContains = "tesco")))
        assertEquals(
            "description ~ \"lidl\" AND counterparty ~ \"v\" AND amount < 0 AND monzo cat = \"groceries\"",
            MoneyCategories.describeMatch(RuleMatch(descriptionContains = "lidl", counterpartyContains = "v", amountSign = "out", monzoCategoryEquals = "groceries")),
        )
        assertEquals("amount > 0", MoneyCategories.describeMatch(RuleMatch(amountSign = "in")))
        assertEquals("Tesco", MoneyCategories.ruleTitle(tesco))
        assertEquals("description ~ \"lidl\" AND amount < 0", MoneyCategories.ruleTitle(shared))
    }

    @Test
    fun `sorted orders by priority then id, like the hub's stable sort`() {
        assertEquals(listOf("rule_tesco", "rule_shared", "rule_monzo"), MoneyCategories.sorted(listOf(monzo, shared, tesco)).map { it.id })
        val tie = listOf(tesco.copy(id = "rule_b", priority = 1), tesco.copy(id = "rule_a", priority = 1))
        assertEquals(listOf("rule_a", "rule_b"), MoneyCategories.sorted(tie).map { it.id })
    }

    @Test
    fun `a create omits empty optionals, an edit sends them as null so the hub's assign clears them`() {
        val create = MoneyCategories.ruleBody(tesco, isEdit = false)
        assertEquals(
            """{"id":"rule_tesco","priority":10,"label":"Tesco","match":{"merchantContains":"tesco"},"categoryId":"cat_food"}""",
            create,
        )
        val edit = MoneyJson.json.parseToJsonElement(MoneyCategories.ruleBody(tesco, isEdit = true)).jsonObject
        assertEquals("null", edit["ignore"].toString())
        assertEquals("null", edit["asTransfer"].toString())
        assertEquals("null", edit["sharedFraction"].toString())
        assertEquals("null", edit["sharedWithCounterparty"].toString())
        assertEquals("\"Tesco\"", edit["label"].toString())
        val sharedEdit = MoneyJson.json.parseToJsonElement(MoneyCategories.ruleBody(shared, isEdit = true)).jsonObject
        assertEquals("0.5", sharedEdit["sharedFraction"].toString())
        assertEquals("null", sharedEdit["label"].toString())
        assertEquals("""{"descriptionContains":"lidl","amountSign":"out"}""", sharedEdit["match"].toString())
    }

    @Test
    fun `parseShare clamps to 0-1 and formatShare drops noise`() {
        assertNull(MoneyCategories.parseShare(""))
        assertNull(MoneyCategories.parseShare("half"))
        assertEquals(0.5, MoneyCategories.parseShare(" 0.5 ")!!, 1e-9)
        assertEquals(1.0, MoneyCategories.parseShare("3")!!, 1e-9)
        assertEquals(0.0, MoneyCategories.parseShare("-1")!!, 1e-9)
        assertEquals("0.5", MoneyCategories.formatShare(0.5))
        assertEquals("1", MoneyCategories.formatShare(1.0))
        assertEquals("0.33", MoneyCategories.formatShare(1.0 / 3))
    }

    @Test
    fun `rule wire shape round-trips through the cache and reads the hub's live shape`() {
        val body = """[{"id":"rule_monzo_cash","priority":100,"label":"Monzo: cash","match":{"monzoCategoryEquals":"cash"},"categoryId":"cat_uncat"},
            {"id":"rule_x","priority":5,"match":{"merchantContains":"lidl","amountSign":"out"},"categoryId":"cat_food","ignore":true,"sharedFraction":0.5,"sharedWithCounterparty":"Veronica"}]"""
        val rules = MoneyJson.decodeRules(body)
        assertEquals(2, rules.size)
        assertEquals(RuleMatch(monzoCategoryEquals = "cash"), rules[0].match)
        assertTrue(rules[1].ignore)
        assertEquals(0.5, rules[1].sharedFraction!!, 1e-9)
        assertEquals("Veronica", rules[1].sharedWithCounterparty)
        assertEquals(rules, MoneyJson.decodeRules(MoneyJson.encodeRules(rules)))
        assertEquals(rules, MoneyJson.parseRules("""{"rules":$body}"""))
    }

    @Test
    fun `category wire shape round-trips with variable and archived`() {
        val cats = listOf(food, salary, old, transfer)
        assertEquals(cats, MoneyJson.decodeCategories(MoneyJson.encodeCategories(cats)))
    }

    // ---- outbox payloads + heals ----------------------------------------

    @Test
    fun `category action round-trips including the cascade a delete carried`() {
        val a = MoneyCategories.CategoryAction("cat_food", null, food, listOf(tesco, shared), listOf(Budget("b1", "cat_food", 1500, notes = "n")))
        assertEquals(a, MoneyCategories.decodeCategoryAction(MoneyCategories.encodeCategoryAction(a)))
        val create = MoneyCategories.CategoryAction("cat_new", MoneyCategories.categoryBody(food), null)
        assertEquals(create, MoneyCategories.decodeCategoryAction(MoneyCategories.encodeCategoryAction(create)))
        assertNull(MoneyCategories.decodeCategoryAction("{}"))
    }

    @Test
    fun `rule action round-trips`() {
        val a = MoneyCategories.RuleAction("rule_shared", MoneyCategories.ruleBody(shared, true), shared)
        assertEquals(a, MoneyCategories.decodeRuleAction(MoneyCategories.encodeRuleAction(a)))
        assertNull(MoneyCategories.decodeRuleAction("nope"))
    }

    @Test
    fun `a refused category delete puts the category and its cascaded rules and budgets back`() {
        val a = MoneyCategories.CategoryAction("cat_food", null, food, listOf(tesco), listOf(Budget("b1", "cat_food", 1)))
        assertEquals(listOf(salary, food), MoneyCategories.healedCategories(listOf(salary), a))
        assertEquals(listOf(tesco, monzo), MoneyCategories.healedRulesAfterCategory(listOf(monzo), a))
        assertEquals(listOf("b2", "b1"), MoneyCategories.healedBudgetsAfterCategory(listOf(Budget("b2", "cat_x", 2)), a).map { it.id })
    }

    @Test
    fun `a refused category edit restores the old record and a refused create drops the row`() {
        val renamed = food.copy(name = "Groceries")
        val edit = MoneyCategories.CategoryAction("cat_food", MoneyCategories.categoryBody(renamed), food)
        assertEquals(listOf(food), MoneyCategories.healedCategories(listOf(renamed), edit))
        // An edit's heal never touches rules/budgets.
        assertEquals(listOf(monzo), MoneyCategories.healedRulesAfterCategory(listOf(monzo), edit))
        val create = MoneyCategories.CategoryAction("cat_new", MoneyCategories.categoryBody(renamed.copy(id = "cat_new")), null)
        assertEquals(listOf(food), MoneyCategories.healedCategories(listOf(food, renamed.copy(id = "cat_new")), create))
    }

    @Test
    fun `a refused rule write restores or drops, keeping priority order`() {
        val moved = tesco.copy(priority = 500)
        assertEquals(listOf(tesco, monzo), MoneyCategories.healedRules(listOf(monzo, moved), MoneyCategories.RuleAction("rule_tesco", "{}", tesco)))
        assertEquals(listOf(monzo), MoneyCategories.healedRules(listOf(monzo, tesco), MoneyCategories.RuleAction("rule_tesco", "{}", null)))
        assertEquals(listOf(tesco, monzo), MoneyCategories.healedRules(listOf(monzo), MoneyCategories.RuleAction("rule_tesco", null, tesco)))
    }

    @Test
    fun `availableCategories for a budget skips archived as well as system and budgeted`() {
        val out = MoneyBudgets.availableCategories(listOf(food, salary, old, transfer, food.copy(id = "cat_fun")), listOf(Budget("b", "cat_food", 1)))
        assertEquals(listOf("cat_fun"), out.map { it.id })
    }
}
