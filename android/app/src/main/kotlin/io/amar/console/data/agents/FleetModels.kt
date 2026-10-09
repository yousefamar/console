package io.amar.console.data.agents

/**
 * The model ids the fleet picker offers per auth backend — a verbatim port of
 * the SPA's `src/utils/fleet-models.ts` (keep in sync; FleetModelsTest pins it).
 * Haiku 5.5 is absent on purpose: CLI 2.1.292 answers `unrecognized_model`.
 */
object FleetModels {
    val FIRST_PARTY: List<String> = listOf(
        "claude-opus-5-5",
        "claude-opus-5",
        "claude-fable-5-1",
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-sonnet-5",
        "claude-haiku-4-5-20251001",
    )

    val BEDROCK: List<String> = listOf(
        "us.anthropic.claude-opus-5-5",
        "us.anthropic.claude-opus-5",
        "us.anthropic.claude-fable-5-1",
        "us.anthropic.claude-fable-5",
        "us.anthropic.claude-opus-4-8",
        "us.anthropic.claude-opus-4-7",
        "us.anthropic.claude-sonnet-5-5",
        "us.anthropic.claude-sonnet-5",
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    )
}
