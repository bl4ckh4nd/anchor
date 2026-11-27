function vectorNodes(nodes, inherited = {}, indent = "    ") {
  return nodes.map(([tag, attrs, children]) => {
    const style = { ...inherited, ...attrs };
    if (tag === "g") {
      if (!attrs.transform) return vectorNodes(children, style, indent);
      const transform = /^translate\(([-.\d]+) ([-.\d]+)\) rotate\(([-.\d]+) 12 12\)$/.exec(attrs.transform);
      if (!transform) throw new Error("Unsupported note tile transform: " + attrs.transform);
      const [, x, y, angle] = transform;
      return [
        `${indent}<group android:translateX="${x}" android:translateY="${y}"`,
        `${indent}    android:pivotX="12" android:pivotY="12" android:rotation="${angle}">`,
        vectorNodes(children, style, indent + "    "),
        `${indent}</group>`,
      ].join("\n");
    }
    let d = attrs.d;
    if (tag === "circle") {
      const x = +attrs.cx, y = +attrs.cy, r = +attrs.r;
      d = `M${x - r} ${y}A${r} ${r} 0 1 0 ${x + r} ${y}A${r} ${r} 0 1 0 ${x - r} ${y}Z`;
    } else if (tag !== "path") {
      throw new Error("Unsupported note tile shape: " + tag);
    }
    const paint = [
      style.fill && style.fill !== "none" && `android:fillColor="${style.fill}"`,
      style.stroke && `android:strokeColor="${style.stroke}"`,
      style["stroke-width"] && `android:strokeWidth="${style["stroke-width"]}"`,
      style["stroke-linecap"] && `android:strokeLineCap="${style["stroke-linecap"]}"`,
      style["stroke-linejoin"] && `android:strokeLineJoin="${style["stroke-linejoin"]}"`,
    ].filter(Boolean);
    return [
      `${indent}<path android:pathData="${d}"`,
      `${indent}    ${paint.join(" ")}/>`,
    ].join("\n");
  }).join("\n");
}

export function composeCardTypography(base, dtcg, header) {
  const roles = [["noteCardTitle", "cardTitle"], ["noteCardBody", "cardBody"], ["noteCardFootnote", "footnote"]];
  const rows = roles.map(([name, role]) => {
    const style = base.get("type." + role).value;
    return [
      `internal val ${name} = TextStyle(`,
      `    fontSize = ${style.fontSize.value}.sp,`,
      `    lineHeight = ${style.lineHeight}.em,`,
      `    letterSpacing = ${style.letterSpacing.value}.sp,`,
      `    fontWeight = FontWeight(${dtcg.css("fontWeight", style.fontWeight)}),`,
      ")", "",
    ].join("\n");
  });
  return `// ${header}
package anchor

import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

${rows.join("\n")}`;
}

export function composeDensity(base, header) {
  const modes = [["Standard", "default"], ["Compact", "compact"]];
  const rows = modes.map(([name, mode]) => {
    const prefix = `density.${mode}.`;
    const space = [8, 12, 16].map((size) => base[prefix + "space." + size].replace(/px$/, ".dp"));
    const previews = ["list", "grid", "masonry", "pictures"].map((kind) => base[prefix + "preview." + kind]);
    const leading = (Number(base[prefix + "noteLineHeight"]) / Number(base["density.default.noteLineHeight"])).toFixed(6);
    return `    ${name}("${name}", ${[...space, ...previews, leading + "f"].join(", ")}),`;
  });
  return `// ${header}
package anchor

import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

internal enum class AnchorDensity(
    val label: String,
    val space8: Dp,
    val space12: Dp,
    val space16: Dp,
    val listPreviewLines: Int,
    val gridPreviewLines: Int,
    val masonryPreviewLines: Int,
    val maxPictures: Int,
    val leadingScale: Float,
) {
${rows.join("\n")}
}
`;
}

export function composePatternVector({ width, height, nodes }, header) {
  return `<!-- ${header} -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="${width}dp" android:height="${height}dp"
    android:viewportWidth="${width}" android:viewportHeight="${height}">
${vectorNodes(nodes)}
</vector>`;
}

export function composeNotePalettes(backgrounds, highlights, css, header) {
  const patterns = backgrounds.filter((bg) => bg.kind);
  const argb = (hex) => "0xFF" + hex.slice(1).toUpperCase();
  const color = (theme, note, field) => argb(css[theme][`color.note.${note}.${field}`]);
  const rows = backgrounds.filter((bg) => bg.id).map(({ id, kind, note }) => {
    const colors = ["light", "dark"].flatMap((t) => ["bg", "border"].map((p) => color(t, note, p)));
    if (!kind) return `    "${id}" to NotePalette(${colors.join(", ")}),`;
    return [
      `    "${id}" to NotePalette(`,
      `        ${colors.join(", ")},`,
      `        NotePatternTile(Res.drawable.${id}, ${color("light", note, "pattern")}, ${color("dark", note, "pattern")}),`,
      "    ),",
    ].join("\n");
  });
  const highlightRows = ["light", "dark"].map((theme) => {
    const fills = highlights.map((name) => [name, css[theme][`color.highlight.${name}.fill`]]);
    for (const { id, note } of backgrounds) {
      if (!id) continue;
      for (const name of highlights) {
        const fill = css[theme][`color.note.${note}.highlight.${name}.fill`];
        if (fill && fill !== css[theme][`color.highlight.${name}.fill`]) fills.push([`${id}/${name}`, fill]);
      }
    }
    return `private val ${theme}HighlightFills = mapOf(\n` +
      fills.map(([id, fill]) => `    "${id}" to ${argb(fill)},`).join("\n") + "\n)";
  });
  return `// ${header}
package anchor

import anchor.resources.Res
${patterns.map(({ id }) => `import anchor.resources.${id}`).join("\n")}
import org.jetbrains.compose.resources.DrawableResource

internal data class NotePatternTile(val drawable: DrawableResource, val lightColor: Long, val darkColor: Long)

internal data class NotePalette(
    val lightFill: Long,
    val lightEdge: Long,
    val darkFill: Long,
    val darkEdge: Long,
    val pattern: NotePatternTile? = null,
)

private val notePalettes = mapOf(
${rows.join("\n")}
)

internal val noteBackgroundNames = linkedMapOf(
${backgrounds.map(({ id, name }) => `    ${JSON.stringify(id)} to ${JSON.stringify(name)},`).join("\n")}
)

internal fun notePalette(background: String?): NotePalette? = notePalettes[background]

internal val noteHighlightNames = listOf(${highlights.map((name) => JSON.stringify(name)).join(", ")})

${highlightRows.join("\n\n")}

internal fun noteHighlightFill(name: String, background: String?, dark: Boolean): Long {
    val fills = if (dark) darkHighlightFills else lightHighlightFills
    return fills["$background/$name"] ?: fills.getValue(name)
}`;
}
