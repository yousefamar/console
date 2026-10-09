package io.amar.console.data.money

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** `/finance/monthly` is cached in the meta table so the chart opens offline. */
@RunWith(RobolectricTestRunner::class)
class MoneyRepositoryMonthlyTest {

    private lateinit var db: ConsoleDb
    private var monthlyCode = 200
    private var monthlyBody = """[{"month":"2026-08","byCategory":{"cat_food":8000}},{"month":"2026-09","byCategory":{"cat_food":12000,"cat_rent":90000}}]"""

    private val hub = HubClient(
        OkHttpClient.Builder().addInterceptor { chain ->
            val req = chain.request()
            val path = req.url.encodedPath
            val (code, text) = when {
                path.endsWith("/finance/monthly") -> monthlyCode to monthlyBody
                path.endsWith("/money/transactions") -> 200 to "[]"
                path.endsWith("/finance/categorise") -> 200 to "{}"
                path.endsWith("/finance/overrides") -> 200 to "[]"
                path.endsWith("/finance/budget-status") -> 200 to "[]"
                path.endsWith("/finance/networth/history") -> 200 to "[]"
                else -> 404 to """{"error":"nope"}"""
            }
            Response.Builder().request(req).protocol(Protocol.HTTP_1_1).code(code).message("x")
                .body(text.toResponseBody("application/json".toMediaType())).build()
        }.build()
    )

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), ConsoleDb::class.java).allowMainThreadQueries().build()
    }

    @After
    fun tearDown() = db.close()

    @Test
    fun `reconcile stores the months and a fresh repository hydrates them without the hub`() = runTest {
        MoneyRepository(db, hub).reconcile()
        val fresh = MoneyRepository(db, hub)
        fresh.hydrate()
        assertEquals(listOf("2026-08", "2026-09"), fresh.state.value.monthly.map { it.month })
        assertEquals(90_000L, fresh.state.value.monthly[1].byCategory["cat_rent"])
    }

    @Test
    fun `a failing monthly route keeps the cached chart`() = runTest {
        val repo = MoneyRepository(db, hub)
        repo.reconcile()
        monthlyCode = 500
        monthlyBody = """{"error":"boom"}"""
        repo.reconcile()
        assertEquals(2, repo.state.value.monthly.size)
        val fresh = MoneyRepository(db, hub)
        fresh.hydrate()
        assertEquals(2, fresh.state.value.monthly.size)
    }
}
