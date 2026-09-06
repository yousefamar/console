package io.amar.console.data.db

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

// ---------------------------------------------------------------------- //
// Money — Monzo transaction mirror for offline read (v15). Hub-side cache is
// authoritative (`monzo-transactions.json`); this holds the recent window
// plus the effective category from `/finance/categorise`, denormalised onto
// the row so the list renders offline with no second lookup.

@Entity(tableName = "money_transactions", indices = [Index("createdAt")])
data class MoneyTxRow(
    @PrimaryKey val id: String,
    /** Minor units, negative = spend. */
    val amount: Long,
    val currency: String,
    /** Raw ISO created. */
    val created: String,
    /** Epoch ms of [created] — the sort key. */
    val createdAt: Long,
    /** Empty string while pending. */
    val settled: String,
    val description: String,
    val merchantName: String?,
    val merchantEmoji: String?,
    val merchantLogo: String?,
    val counterpartyName: String?,
    /** Monzo's own coarse category (eating_out, groceries, …). */
    val monzoCategory: String,
    val declineReason: String?,
    val notes: String?,
    /** Effective finance category id (rules + overrides); null = uncategorised/unknown. */
    val categoryId: String?,
    val ignored: Boolean,
    val isTransfer: Boolean,
)

@Dao
interface MoneyDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertAll(rows: List<MoneyTxRow>)

    @Query("SELECT * FROM money_transactions ORDER BY createdAt DESC LIMIT :limit")
    fun observeRecent(limit: Int): Flow<List<MoneyTxRow>>

    @Query("SELECT * FROM money_transactions WHERE id = :id")
    suspend fun byId(id: String): MoneyTxRow?

    @Query("SELECT COUNT(*) FROM money_transactions")
    suspend fun count(): Int

    /** Keep the cache bounded to the recent window the hub serves. */
    @Query("DELETE FROM money_transactions WHERE id NOT IN (SELECT id FROM money_transactions ORDER BY createdAt DESC LIMIT :keep)")
    suspend fun trimTo(keep: Int)
}
