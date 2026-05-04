using System.Text.RegularExpressions;

namespace Folio.Services;

internal static class HeadingAnchorPreprocessor
{
    // Verbreitetes Markdown-Pattern, um den Auto-Slug eines Headings zu uebersteuern:
    //   ## Titel <a id="explicit-id"></a>
    // Mit DisableHtml() rendert Markdig das Tag escaped als sichtbaren Text und
    // erzeugt keinen Anchor — Inline-Links wie [Text](#explicit-id) laufen ins Leere
    // und im TOC steht der Tag-Quelltext. Wir konvertieren den Tag in Markdig's
    // GenericAttributes-Syntax `{#id}`, die in der Pipeline (UseAdvancedExtensions)
    // bereits aktiv ist und die Heading-Id sauber setzt.

    private static readonly Regex InlineAnchorTag = new(
        @"<a\s+id\s*=\s*[""']([^""']+)[""']\s*>\s*</a>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex HeadingLine = new(
        @"^(?<hashes>\#{1,6})[ \t]+(?<rest>.+?)[ \t]*$",
        RegexOptions.Multiline | RegexOptions.Compiled);

    public static string ConvertInlineAnchorsInHeadings(string markdown)
    {
        if (string.IsNullOrEmpty(markdown)) return markdown;
        if (markdown.IndexOf("<a", StringComparison.OrdinalIgnoreCase) < 0) return markdown;

        return HeadingLine.Replace(markdown, m =>
        {
            var rest = m.Groups["rest"].Value;
            string? lastId = null;
            var stripped = InlineAnchorTag.Replace(rest, anchor =>
            {
                lastId = anchor.Groups[1].Value;
                return string.Empty;
            }).TrimEnd();

            if (lastId is null) return m.Value;
            return $"{m.Groups["hashes"].Value} {stripped} {{#{lastId}}}";
        });
    }
}
