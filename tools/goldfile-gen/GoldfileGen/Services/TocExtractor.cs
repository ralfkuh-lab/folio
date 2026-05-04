using System.Text;
using System.Text.RegularExpressions;
using Markdig;
using Markdig.Syntax;
using Markdig.Syntax.Inlines;
using Markdig.Renderers.Html;

namespace Folio.Services;

public sealed record TocEntry(string Text, int Level, string Slug, string? Number = null)
{
    public string NumberPrefix => Number is null ? string.Empty : $"{Number}. ";
}

public static class TocExtractor
{
    private static readonly Regex ExistingNumberPattern =
        new(@"^\d+(\.\d+)*\.?\s", RegexOptions.Compiled);

    public static IReadOnlyList<TocEntry> Extract(string markdown)
        => Extract(markdown, MarkdownPipelineFactory.Default);

    public static IReadOnlyList<TocEntry> Extract(string markdown, MarkdownPipeline pipeline)
    {
        if (string.IsNullOrEmpty(markdown)) return Array.Empty<TocEntry>();

        // Frontmatter wegnehmen, damit YAML-Zeilen nicht versehentlich als Setext-Headings auftauchen.
        var fm = FrontmatterExtractor.Extract(markdown);
        // `## Titel <a id="explicit-id"></a>` -> `## Titel {#explicit-id}` umschreiben,
        // damit der Tag-Quelltext nicht im TOC sichtbar wird und der explizite Anchor
        // auch beim TocExtractor als Slug ankommt (gleiche Pipeline wie der Renderer).
        var preprocessed = HeadingAnchorPreprocessor.ConvertInlineAnchorsInHeadings(fm.Body);
        var doc = Markdown.Parse(preprocessed, pipeline);
        var raw = new List<TocEntry>();

        foreach (var heading in doc.Descendants<HeadingBlock>())
        {
            var text = ExtractText(heading.Inline);
            var slug = heading.GetAttributes().Id ?? string.Empty;
            raw.Add(new TocEntry(text, heading.Level, slug));
        }

        return AssignNumbers(raw);
    }

    internal static List<TocEntry> AssignNumbers(List<TocEntry> entries)
    {
        if (entries.Count == 0) return entries;

        var h2s = entries.Where(e => e.Level == 2).ToList();
        if (h2s.Count == 0) return entries;

        // Dokument hat bereits eigene Nummerierung → Nummer per Regex aus dem
        // Heading-Text herausziehen, damit Style/Farbe/Hanging-Indent identisch
        // sind wie bei auto-nummerierten Eintraegen.
        // Heuristik: nicht nur das erste H2 ansehen — sonst klassifiziert ein
        // vorangestelltes "## Inhalt"/"## Inhaltsverzeichnis" das Dokument
        // faelschlich als unnummeriert und der Auto-Pass haengt zusaetzliche
        // Zahlen vor die schon vorhandenen. Stattdessen: wenn mindestens die
        // Haelfte der H2s schon mit einer Nummer beginnt, ist das Dokument
        // selbst-nummeriert.
        var numberedH2Count = h2s.Count(h => ExistingNumberPattern.IsMatch(h.Text));
        if (numberedH2Count * 2 >= h2s.Count)
            return ExtractExistingNumbers(entries);

        return ApplyAutoNumbering(entries);
    }

    private static List<TocEntry> ExtractExistingNumbers(List<TocEntry> entries)
    {
        var result = new List<TocEntry>(entries.Count);
        foreach (var entry in entries)
        {
            if (entry.Level >= 2 && TrySplitExistingNumber(entry.Text) is { } split)
                result.Add(entry with { Number = split.Number, Text = split.Text });
            else
                result.Add(entry);
        }
        return result;
    }

    private static (string Number, string Text)? TrySplitExistingNumber(string text)
    {
        var m = ExistingNumberPattern.Match(text);
        if (!m.Success) return null;
        var number = m.Value.TrimEnd().TrimEnd('.');
        var remainder = text.Substring(m.Length);
        return (number, remainder);
    }

    private static List<TocEntry> ApplyAutoNumbering(List<TocEntry> entries)
    {
        var counters = new int[6];
        var result = new List<TocEntry>(entries.Count);

        foreach (var entry in entries)
        {
            if (entry.Level < 2 || entry.Level > 6)
            {
                result.Add(entry);
                continue;
            }

            var depth = entry.Level - 1;
            counters[depth - 1]++;
            for (var i = depth; i < counters.Length; i++) counters[i] = 0;

            var number = string.Join(".", counters.Take(depth));
            result.Add(entry with { Number = number });
        }

        return result;
    }

    private static string ExtractText(ContainerInline? container)
    {
        if (container is null) return string.Empty;
        var sb = new StringBuilder();
        AppendText(container, sb);
        return sb.ToString();
    }

    private static void AppendText(ContainerInline container, StringBuilder sb)
    {
        foreach (var inline in container)
        {
            switch (inline)
            {
                case LiteralInline lit:
                    sb.Append(lit.Content.AsSpan());
                    break;
                case CodeInline code:
                    sb.Append(code.Content);
                    break;
                case LineBreakInline:
                    sb.Append(' ');
                    break;
                case ContainerInline c:
                    AppendText(c, sb);
                    break;
            }
        }
    }
}
