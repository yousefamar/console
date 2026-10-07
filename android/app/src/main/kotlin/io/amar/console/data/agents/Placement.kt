package io.amar.console.data.agents

/**
 * Which glyph a session row wears. Remoteness and lineage are separate axes:
 * the cloud wins the glyph slot, the fork indent stays (SPA SpacesTab.tsx
 * 83157d29 / baf9d507 — BotCloud / BranchCloud vs Bot / GitBranch).
 */
enum class SessionGlyph { BOT, BOT_CLOUD, BRANCH, BRANCH_CLOUD }

/** `SessionInfo.placement === 'forge'`; a missing field (older hub) is local. */
fun isRemotePlacement(placement: String?): Boolean = placement == "forge"

fun sessionGlyph(placement: String?, isFork: Boolean): SessionGlyph = when {
    isRemotePlacement(placement) && isFork -> SessionGlyph.BRANCH_CLOUD
    isRemotePlacement(placement) -> SessionGlyph.BOT_CLOUD
    isFork -> SessionGlyph.BRANCH
    else -> SessionGlyph.BOT
}

/** Status-bar chip text: `forge`, or `forge:5174` when a dev port is tunnelled. */
fun placementChip(placement: String?, devPort: Int?): String? =
    if (!isRemotePlacement(placement)) null else "forge" + (devPort?.let { ":$it" } ?: "")

const val FORGE_TOOLTIP = "The claude process runs on forge (AWS); the cwd is mirrored there"
