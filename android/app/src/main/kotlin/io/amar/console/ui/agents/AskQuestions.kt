package io.amar.console.ui.agents

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/**
 * Pure half of the AskUserQuestion card — port of the normalize/buildAnswerFor
 * logic in AgentToolApproval.tsx so the payload shape stays identical to the
 * desktop's: `{questions, answers: Record<question, string[]>}` where each
 * entry lists the selected option labels followed by the free text, if any.
 */
object AskQuestions {
    data class Option(val label: String, val description: String?)
    data class Question(
        val question: String,
        val header: String?,
        val options: List<Option>,
        val multiSelect: Boolean,
        /** The original element, echoed back verbatim in the answer payload. */
        val raw: JsonElement,
    )

    /** `input.questions[]`, else the legacy single-question top-level shape. */
    fun parse(input: JsonObject): List<Question> {
        val arr = (input["questions"] as? JsonArray)?.mapNotNull { it as? JsonObject }
            ?: input["question"]?.let { q ->
                listOf(buildJsonObject {
                    put("question", q)
                    input["options"]?.let { put("options", it) }
                    input["multiSelect"]?.let { put("multiSelect", it) }
                })
            }
            ?: emptyList()
        return arr.mapNotNull { q ->
            val text = (q["question"] as? JsonPrimitive)?.content ?: return@mapNotNull null
            Question(
                question = text,
                header = (q["header"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() },
                options = (q["options"] as? JsonArray)?.mapNotNull { o ->
                    val obj = o as? JsonObject ?: return@mapNotNull null
                    val label = (obj["label"] as? JsonPrimitive)?.content ?: return@mapNotNull null
                    Option(label, (obj["description"] as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() })
                } ?: emptyList(),
                multiSelect = q["multiSelect"]?.jsonPrimitive?.booleanOrNull ?: false,
                raw = q,
            )
        }
    }

    /** Selected option labels (in option order) then the trimmed free text. */
    fun answerFor(q: Question, selected: Set<Int>, freeText: String): List<String> {
        val out = q.options.withIndex().filter { it.index in selected }.map { it.value.label }
        val free = freeText.trim()
        return if (free.isEmpty()) out else out + free
    }

    fun isAnswered(q: Question, selected: Set<Int>, freeText: String): Boolean =
        answerFor(q, selected, freeText).isNotEmpty()

    /** Single-select replaces; multi-select toggles. */
    fun toggle(q: Question, selected: Set<Int>, index: Int): Set<Int> = when {
        index in selected -> selected - index
        q.multiSelect -> selected + index
        else -> setOf(index)
    }

    fun payload(questions: List<Question>, selections: List<Set<Int>>, freeTexts: List<String>): JsonObject =
        buildJsonObject {
            put("questions", JsonArray(questions.map { it.raw }))
            putJsonObject("answers") {
                questions.forEachIndexed { i, q ->
                    val answer = answerFor(q, selections.getOrElse(i) { emptySet() }, freeTexts.getOrElse(i) { "" })
                    put(q.question, JsonArray(answer.map { JsonPrimitive(it) }))
                }
            }
        }
}
