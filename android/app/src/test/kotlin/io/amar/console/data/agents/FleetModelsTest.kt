package io.amar.console.data.agents

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** Holds FleetModels to the SPA's src/utils/fleet-models.ts, read from the repo. */
class FleetModelsTest {
    private val spa: String by lazy {
        generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "src/utils/fleet-models.ts") }
            .first { it.exists() }
            .readText()
    }

    private fun spaList(name: String): List<String> {
        val body = Regex("""export const $name = \[(.*?)\]""", RegexOption.DOT_MATCHES_ALL).find(spa)!!.groupValues[1]
        return Regex("""'([^']+)'""").findAll(body).map { it.groupValues[1] }.toList()
    }

    @Test fun `first-party list matches the SPA`() = assertEquals(spaList("FIRST_PARTY_MODELS"), FleetModels.FIRST_PARTY)

    @Test fun `bedrock list matches the SPA`() = assertEquals(spaList("BEDROCK_MODELS"), FleetModels.BEDROCK)

    @Test fun `haiku 5_5 stays absent`() {
        assertFalse((FleetModels.FIRST_PARTY + FleetModels.BEDROCK).any { "haiku-5-5" in it })
    }
}
