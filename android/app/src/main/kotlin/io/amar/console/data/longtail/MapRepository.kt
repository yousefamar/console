package io.amar.console.data.longtail

import io.amar.console.core.HubClient
import io.amar.console.data.db.ConsoleDb
import io.amar.console.data.db.GeocacheRow
import io.amar.console.data.db.MeetupEventRow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

private val json = Json { ignoreUnknownKeys = true }

/** Map data: geocache + meetup summary mirrors (pins render offline). */
class MapRepository(private val db: ConsoleDb, private val hub: HubClient) {
    suspend fun geocaches(): List<GeocacheRow> = db.map().geocaches()
    suspend fun upcomingMeetup(): List<MeetupEventRow> =
        db.map().upcomingMeetup(System.currentTimeMillis())

    suspend fun reconcile() {
        runCatching {
            val resp = hub.get("/geocaching/caches")
            val arr = (json.parseToJsonElement(resp).jsonObject["caches"] as? JsonArray)
                ?: json.parseToJsonElement(resp) as? JsonArray
            val rows = arr?.mapNotNull { c ->
                val o = c as? JsonObject ?: return@mapNotNull null
                val code = o["code"]?.jsonPrimitive?.content ?: return@mapNotNull null
                GeocacheRow(
                    code = code,
                    name = o["name"]?.jsonPrimitive?.content ?: code,
                    type = o["type"]?.jsonPrimitive?.content ?: "traditional",
                    lat = o["lat"]?.jsonPrimitive?.doubleOrNull,
                    lon = o["lon"]?.jsonPrimitive?.doubleOrNull,
                    difficulty = o["difficulty"]?.jsonPrimitive?.doubleOrNull,
                    terrain = o["terrain"]?.jsonPrimitive?.doubleOrNull,
                    found = o["found"]?.jsonPrimitive?.booleanOrNull ?: false,
                )
            } ?: emptyList()
            if (rows.isNotEmpty()) db.map().upsertGeocaches(rows)
        }
        runCatching {
            val resp = hub.get("/meetup/events")
            val arr = (json.parseToJsonElement(resp).jsonObject["events"] as? JsonArray)
                ?: json.parseToJsonElement(resp) as? JsonArray
            val rows = arr?.mapNotNull { e ->
                val o = e as? JsonObject ?: return@mapNotNull null
                val id = o["id"]?.jsonPrimitive?.content ?: return@mapNotNull null
                MeetupEventRow(
                    id = id,
                    title = o["title"]?.jsonPrimitive?.content ?: "(event)",
                    groupName = o["groupName"]?.jsonPrimitive?.content,
                    lat = o["lat"]?.jsonPrimitive?.doubleOrNull,
                    lon = o["lon"]?.jsonPrimitive?.doubleOrNull,
                    dateTime = o["dateTime"]?.jsonPrimitive?.longOrNull ?: 0L,
                    eventUrl = o["eventUrl"]?.jsonPrimitive?.content,
                )
            } ?: emptyList()
            if (rows.isNotEmpty()) {
                db.map().upsertMeetup(rows)
                db.map().deleteAbsentMeetup(rows.map { it.id }) // snapshot-authoritative
            }
        }
    }
}
