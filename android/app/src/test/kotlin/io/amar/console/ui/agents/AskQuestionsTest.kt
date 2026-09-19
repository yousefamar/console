package io.amar.console.ui.agents

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AskQuestionsTest {

    private fun obj(s: String) = Json.parseToJsonElement(s).jsonObject

    private val twoQuestions = obj(
        """
        {"questions":[
          {"question":"Which DB?","header":"Storage","multiSelect":false,
           "options":[{"label":"Postgres","description":"relational"},{"label":"Redis"}]},
          {"question":"Which regions?","multiSelect":true,
           "options":[{"label":"eu"},{"label":"us"},{"label":"ap"}]}
        ]}
        """.trimIndent(),
    )

    @Test
    fun `parses questions array with headers and descriptions`() {
        val qs = AskQuestions.parse(twoQuestions)
        assertEquals(2, qs.size)
        assertEquals("Storage", qs[0].header)
        assertEquals("relational", qs[0].options[0].description)
        assertNull(qs[0].options[1].description)
        assertFalse(qs[0].multiSelect)
        assertTrue(qs[1].multiSelect)
    }

    @Test
    fun `parses legacy single-question shape`() {
        val qs = AskQuestions.parse(obj("""{"question":"Go?","options":[{"label":"Yes"}],"multiSelect":false}"""))
        assertEquals(1, qs.size)
        assertEquals("Go?", qs[0].question)
        assertEquals(listOf("Yes"), qs[0].options.map { it.label })
        assertNull(qs[0].header)
    }

    @Test
    fun `renders nothing for an unrecognised shape`() {
        assertTrue(AskQuestions.parse(obj("""{"foo":1}""")).isEmpty())
    }

    @Test
    fun `single-select replaces, multi-select toggles`() {
        val (single, multi) = AskQuestions.parse(twoQuestions)
        assertEquals(setOf(1), AskQuestions.toggle(single, setOf(0), 1))
        assertEquals(emptySet<Int>(), AskQuestions.toggle(single, setOf(0), 0))
        assertEquals(setOf(0, 2), AskQuestions.toggle(multi, setOf(0), 2))
        assertEquals(setOf(2), AskQuestions.toggle(multi, setOf(0, 2), 0))
    }

    @Test
    fun `answer lists selected labels in option order then the free text`() {
        val multi = AskQuestions.parse(twoQuestions)[1]
        assertEquals(listOf("eu", "ap", "also sa"), AskQuestions.answerFor(multi, setOf(2, 0), "  also sa "))
        assertEquals(listOf("us"), AskQuestions.answerFor(multi, setOf(1), ""))
        assertEquals(listOf("free"), AskQuestions.answerFor(multi, emptySet(), "free"))
        assertFalse(AskQuestions.isAnswered(multi, emptySet(), "   "))
    }

    @Test
    fun `payload echoes the raw questions and keys answers by question text`() {
        val qs = AskQuestions.parse(twoQuestions)
        val p = AskQuestions.payload(qs, listOf(setOf(0), setOf(1, 2)), listOf("", "maybe sa"))
        assertEquals(2, p["questions"]!!.jsonArray.size)
        assertEquals("Storage", p["questions"]!!.jsonArray[0].jsonObject["header"]!!.jsonPrimitive.content)
        val answers = p["answers"]!!.jsonObject
        assertEquals(listOf("Postgres"), answers["Which DB?"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals(listOf("us", "ap", "maybe sa"), answers["Which regions?"]!!.jsonArray.map { it.jsonPrimitive.content })
    }
}
