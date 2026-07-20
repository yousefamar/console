package io.amar.console.data.notes

import io.amar.console.data.db.NoteFileRow
import kotlin.math.sqrt

/**
 * Circle-pack layout for the notes "circles" view — a Kotlin port of
 * d3-hierarchy's pack (packSiblings front-chain + packEnclose / Welzl), plus
 * the helpers from src/components/notes/circles-view-helpers.ts.
 *
 * File circles are area-weighted by size; folders synthesized; laid out in a
 * fixed CANVAS×CANVAS user space. Pure — no canvas/graphics dependency, so it
 * unit-tests cleanly.
 */
object CirclesLayout {
    const val ROOT_PATH = "__root__"
    const val CANVAS = 1000.0
    const val PADDING = 8.0

    /** Cover fades once a folder's apparent radius exceeds 0.4×min(W,H). */
    fun coverFadeThreshold(w: Double, h: Double): Double = minOf(w, h) * 0.4

    class Node(
        val path: String,
        val isFile: Boolean,
        val size: Long,
        val mtime: Long,
        val name: String,
    ) {
        var x = 0.0
        var y = 0.0
        var r = 0.0
        var value = 0.0
        var depth = 0
        var parent: Node? = null
        val children = ArrayList<Node>()
    }

    /** Build the packed hierarchy from a flat file list, or null when empty. */
    fun build(files: List<NoteFileRow>): Node? {
        if (files.isEmpty()) return null
        val nodes = LinkedHashMap<String, Node>()
        nodes[ROOT_PATH] = Node(ROOT_PATH, false, 0, 0, "vault")

        for (f in files) {
            nodes[f.path] = Node(
                path = f.path,
                isFile = true,
                size = maxOf(1L, f.size),
                mtime = f.mtime,
                name = f.name.removeSuffix(".md"),
            )
            val parts = if (f.dir.isNotEmpty()) f.dir.split('/').filter { it.isNotEmpty() } else emptyList()
            for (i in parts.indices) {
                val dirPath = parts.subList(0, i + 1).joinToString("/")
                if (!nodes.containsKey(dirPath)) {
                    nodes[dirPath] = Node(dirPath, false, 0, 0, parts[i])
                }
            }
        }

        // Wire parent/child edges.
        for (n in nodes.values) {
            if (n.path == ROOT_PATH) continue
            val idx = n.path.lastIndexOf('/')
            val parentPath = if (idx < 0) ROOT_PATH else n.path.substring(0, idx)
            val parent = nodes[parentPath] ?: nodes[ROOT_PATH]!!
            n.parent = parent
            parent.children.add(n)
        }
        val root = nodes[ROOT_PATH]!!
        computeDepth(root, 0)
        // value = sum of descendant file sizes; sort children by value desc.
        sumValues(root)
        sortByValue(root)
        packHierarchy(root)
        return root
    }

    private fun computeDepth(n: Node, depth: Int) {
        n.depth = depth
        for (c in n.children) computeDepth(c, depth + 1)
    }

    private fun sumValues(n: Node): Double {
        n.value = if (n.isFile) n.size.toDouble()
        else n.children.sumOf { sumValues(it) }
        return n.value
    }

    private fun sortByValue(n: Node) {
        n.children.sortByDescending { it.value }
        for (c in n.children) sortByValue(c)
    }

    // --- d3 pack: recursive packSiblings + enclose, radius from value ------ //

    private fun packHierarchy(root: Node) {
        // Bottom-up: pack each node's children, then set the node's radius to
        // enclose them, then scale/translate into [0,CANVAS].
        root.x = CANVAS / 2
        root.y = CANVAS / 2
        packNode(root)
        // Scale so root fills the canvas (d3 does this at the top level).
        val k = if (root.r > 0) (CANVAS / 2) / root.r else 1.0
        transform(root, CANVAS / 2, CANVAS / 2, root.x, root.y, k)
    }

    private fun transform(n: Node, cx: Double, cy: Double, ox: Double, oy: Double, k: Double) {
        n.x = cx + (n.x - ox) * k
        n.y = cy + (n.y - oy) * k
        n.r *= k
        for (c in n.children) transform(c, cx, cy, ox, oy, k)
    }

    private fun packNode(n: Node) {
        if (n.children.isEmpty()) {
            // Leaf radius from value (area ∝ value).
            n.r = if (n.isFile) sqrt(n.value) else 0.0
            return
        }
        for (c in n.children) packNode(c)
        packChildren(n.children)
        val e = enclose(n.children)
        if (e != null) {
            // Recenter children around (0,0), set node radius (+ padding).
            for (c in n.children) { c.x -= e.x; c.y -= e.y }
            n.r = e.r + PADDING
        } else {
            n.r = 0.0
        }
        // Node's own local coords are placeholders; positioned by its parent.
        n.x = 0.0
        n.y = 0.0
    }

    private class Circle(var x: Double, var y: Double, var r: Double)

    /** Front-chain node wrapping a laid-out child (d3's `Node` in packSiblings). */
    private class FrontNode(val c: Node) {
        var next: FrontNode = this
        var prev: FrontNode = this
    }

    /**
     * d3 packSiblingsRandom (deterministic here — order is the value-sorted
     * child list). Positions each child around a shared origin, then recenters
     * on the enclosing circle. Direct port.
     */
    private fun packChildren(children: List<Node>) {
        val n = children.size
        if (n == 0) return
        var a = children[0]; a.x = 0.0; a.y = 0.0
        if (n == 1) return
        var b = children[1]; a.x = -b.r; b.x = a.r; b.y = 0.0
        if (n == 2) return
        var c = children[2]; place(b, a, c)

        var na = FrontNode(a)
        var nb = FrontNode(b)
        val nc0 = FrontNode(c)
        na.next = nc0; nc0.prev = na
        nb.next = na; na.prev = nb
        nc0.next = nb; nb.prev = nc0

        var i = 3
        pack@ while (i < n) {
            c = children[i]; place(na.c, nb.c, c)
            val ncNew = FrontNode(c)

            var j = nb.next
            var k = na.prev
            var sj = nb.c.r
            var sk = na.c.r
            do {
                if (sj <= sk) {
                    if (intersects(j.c, c)) {
                        nb = j; na.next = nb; nb.prev = na; i--
                        continue@pack
                    }
                    sj += j.c.r; j = j.next
                } else {
                    if (intersects(k.c, c)) {
                        na = k; na.next = nb; nb.prev = na; i--
                        continue@pack
                    }
                    sk += k.c.r; k = k.prev
                }
            } while (j !== k.next)

            // Success! Insert c between a and b.
            ncNew.prev = na; ncNew.next = nb; na.next = ncNew; nb.prev = ncNew
            nb = ncNew

            // New closest pair to the centroid.
            var aa = score(na)
            var cur = na.next
            while (cur !== nb) {
                val ca = score(cur)
                if (ca < aa) { na = cur; aa = ca }
                cur = cur.next
            }
            nb = na.next
            i++
        }
    }

    private fun score(node: FrontNode): Double {
        val a = node.c
        val bb = node.next.c
        val ab = a.r + bb.r
        if (ab == 0.0) return 0.0
        val dx = (a.x * bb.r + bb.x * a.r) / ab
        val dy = (a.y * bb.r + bb.y * a.r) / ab
        return dx * dx + dy * dy
    }

    /** Position c externally tangent to a and b (d3 place(b,a,c) semantics). */
    private fun place(b: Node, a: Node, c: Node) {
        val dx = b.x - a.x
        val dy = b.y - a.y
        val d2 = dx * dx + dy * dy
        if (d2 != 0.0) {
            var a2 = a.r + c.r; a2 *= a2
            var b2 = b.r + c.r; b2 *= b2
            if (a2 > b2) {
                val x = (d2 + b2 - a2) / (2 * d2)
                val y = sqrt(maxOf(0.0, b2 / d2 - x * x))
                c.x = b.x - x * dx - y * dy
                c.y = b.y - x * dy + y * dx
            } else {
                val x = (d2 + a2 - b2) / (2 * d2)
                val y = sqrt(maxOf(0.0, a2 / d2 - x * x))
                c.x = a.x + x * dx - y * dy
                c.y = a.y + x * dy + y * dx
            }
        } else {
            c.x = a.x + c.r
            c.y = a.y
        }
    }

    private fun intersects(a: Node, b: Node): Boolean {
        val dr = a.r + b.r - 1e-6
        val dx = b.x - a.x
        val dy = b.y - a.y
        return dr > 0 && dr * dr > dx * dx + dy * dy
    }

    // --- Welzl smallest-enclosing-circle (d3 packEnclose) ------------------ //

    private fun enclose(nodes: List<Node>): Circle? {
        if (nodes.isEmpty()) return null
        val circles = nodes.map { Circle(it.x, it.y, it.r) }
        var i = 0
        var basis: List<Circle> = emptyList()
        var e: Circle? = null
        while (i < circles.size) {
            val p = circles[i]
            if (e != null && enclosesWeak(e, p)) { i++; continue }
            basis = extendBasis(basis, p)
            e = encloseBasis(basis)
            i = 0
        }
        return e
    }

    private fun extendBasis(B: List<Circle>, p: Circle): List<Circle> {
        if (enclosesWeakAll(p, B)) return listOf(p)
        for (i in B.indices) {
            if (enclosesNot(p, B[i]) && enclosesWeakAll(encloseBasis2(B[i], p), B)) {
                return listOf(B[i], p)
            }
        }
        for (i in 0 until B.size - 1) {
            for (j in i + 1 until B.size) {
                if (enclosesNot(encloseBasis2(B[i], B[j]), p) &&
                    enclosesNot(encloseBasis2(B[i], p), B[j]) &&
                    enclosesNot(encloseBasis2(B[j], p), B[i]) &&
                    enclosesWeakAll(encloseBasis3(B[i], B[j], p), B)
                ) {
                    return listOf(B[i], B[j], p)
                }
            }
        }
        // Numerical degeneracy — fall back to a basis of just p.
        return listOf(p)
    }

    private fun enclosesNot(a: Circle, b: Circle): Boolean {
        val dr = a.r - b.r; val dx = b.x - a.x; val dy = b.y - a.y
        return dr < 0 || dr * dr < dx * dx + dy * dy
    }

    private fun enclosesWeak(a: Circle, b: Circle): Boolean {
        val dr = a.r - b.r + maxOf(a.r, b.r, 1.0) * 1e-9
        val dx = b.x - a.x; val dy = b.y - a.y
        return dr > 0 && dr * dr > dx * dx + dy * dy
    }

    private fun enclosesWeakAll(a: Circle, B: List<Circle>): Boolean =
        B.all { enclosesWeak(a, it) }

    private fun encloseBasis(B: List<Circle>): Circle = when (B.size) {
        1 -> Circle(B[0].x, B[0].y, B[0].r)
        2 -> encloseBasis2(B[0], B[1])
        else -> encloseBasis3(B[0], B[1], B[2])
    }

    private fun encloseBasis2(a: Circle, b: Circle): Circle {
        val x1 = a.x; val y1 = a.y; val r1 = a.r
        val x2 = b.x; val y2 = b.y; val r2 = b.r
        val x21 = x2 - x1; val y21 = y2 - y1; val r21 = r2 - r1
        val l = sqrt(x21 * x21 + y21 * y21)
        return Circle(
            (x1 + x2 + x21 / l * r21) / 2,
            (y1 + y2 + y21 / l * r21) / 2,
            (l + r1 + r2) / 2,
        )
    }

    private fun encloseBasis3(a: Circle, b: Circle, c: Circle): Circle {
        val x1 = a.x; val y1 = a.y; val r1 = a.r
        val x2 = b.x; val y2 = b.y; val r2 = b.r
        val x3 = c.x; val y3 = c.y; val r3 = c.r
        val a2 = x1 - x2; val a3 = x1 - x3
        val b2 = y1 - y2; val b3 = y1 - y3
        val c2 = r2 - r1; val c3 = r3 - r1
        val d1 = x1 * x1 + y1 * y1 - r1 * r1
        val d2 = d1 - x2 * x2 - y2 * y2 + r2 * r2
        val d3 = d1 - x3 * x3 - y3 * y3 + r3 * r3
        val ab = a3 * b2 - a2 * b3
        if (ab == 0.0) return encloseBasis2(a, b)
        val xa = (b2 * d3 - b3 * d2) / (ab * 2) - x1
        val xb = (b3 * c2 - b2 * c3) / ab
        val ya = (a3 * d2 - a2 * d3) / (ab * 2) - y1
        val yb = (a2 * c3 - a3 * c2) / ab
        val A = xb * xb + yb * yb - 1
        val B = 2 * (r1 + xa * xb + ya * yb)
        val C = xa * xa + ya * ya - r1 * r1
        val r = if (A != 0.0) -(B + sqrt(B * B - 4 * A * C)) / (2 * A) else -C / B
        return Circle(x1 + xa + xb * r, y1 + ya + yb * r, r)
    }

    // --- traversal helpers (ports of circles-view-helpers.ts) -------------- //

    fun forEach(root: Node, fn: (Node) -> Unit) {
        fn(root)
        for (c in root.children) forEach(c, fn)
    }

    fun findNode(root: Node, path: String): Node? {
        var found: Node? = null
        forEach(root) { if (it.path == path) found = it }
        return found
    }

    fun parentPathOf(path: String): String {
        val idx = path.lastIndexOf('/')
        return if (idx < 0) ROOT_PATH else path.substring(0, idx)
    }

    /** True iff every ancestor (except root) has its cover faded. */
    fun isAncestorChainOpen(node: Node, k: Double, fadeThreshold: Double): Boolean {
        var p = node.parent
        while (p != null) {
            if (p.parent == null) return true
            if (p.r * k <= fadeThreshold) return false
            p = p.parent
        }
        return true
    }

    /** Deepest non-faded visible node containing a user-space point. */
    fun hitTest(root: Node, ux: Double, uy: Double, k: Double, fadeThreshold: Double): Node? {
        var best: Node? = null
        var bestDepth = -1
        forEach(root) { d ->
            if (d.parent == null) return@forEach
            val apparentR = d.r * k
            if (apparentR < 0.6) return@forEach
            val isFaded = d.children.isNotEmpty() && apparentR > fadeThreshold
            if (isFaded) return@forEach
            if (!isAncestorChainOpen(d, k, fadeThreshold)) return@forEach
            val dx = ux - d.x
            val dy = uy - d.y
            if (dx * dx + dy * dy <= d.r * d.r && d.depth > bestDepth) {
                best = d; bestDepth = d.depth
            }
        }
        return best
    }

    /** Deepest folder containing a point, excluding [excludePath] (drag target). */
    fun findDeepestFolderAt(root: Node, x: Double, y: Double, excludePath: String): Node? {
        var best: Node? = null
        var bestDepth = -1
        forEach(root) { d ->
            if (d.isFile) return@forEach
            if (d.path == excludePath) return@forEach
            val dx = x - d.x
            val dy = y - d.y
            if (dx * dx + dy * dy <= d.r * d.r && d.depth > bestDepth) {
                best = d; bestDepth = d.depth
            }
        }
        return best
    }

    /** Truncate to fit maxWidth via a measure fn; null if even 1 char + '…' won't fit. */
    fun truncateLabel(text: String, maxWidth: Double, measure: (String) -> Double): String? {
        if (measure(text) <= maxWidth) return text
        var lo = 1
        var hi = text.length
        while (lo < hi) {
            val mid = (lo + hi + 1) / 2
            if (measure(text.substring(0, mid) + "…") <= maxWidth) lo = mid else hi = mid - 1
        }
        if (lo < 2) return null
        return text.substring(0, lo) + "…"
    }
}
