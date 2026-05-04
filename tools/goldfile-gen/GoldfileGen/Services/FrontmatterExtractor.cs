using System.Net;
using System.Text;

namespace Folio.Services;

public static class FrontmatterExtractor
{
    public readonly record struct Result(IReadOnlyList<Entry> Entries, string Body);

    public readonly record struct Entry(string Key, string Value);

    /// <summary>
    /// Erkennt am Markdown-Anfang einen YAML-Frontmatter-Block (zwischen --- Zeilen),
    /// liefert geparste Key/Value-Paare und das Markdown ohne Frontmatter zurueck.
    /// Kein Frontmatter → leere Entries-Liste, Body unveraendert.
    /// </summary>
    public static Result Extract(string markdown)
    {
        if (string.IsNullOrEmpty(markdown)) return new Result(Array.Empty<Entry>(), markdown);

        // Akzeptierte Trennzeile am Anfang: "---" optional gefolgt von \r und \n.
        if (!markdown.StartsWith("---", StringComparison.Ordinal)) return new Result(Array.Empty<Entry>(), markdown);
        var firstLineEnd = markdown.IndexOf('\n');
        if (firstLineEnd < 0) return new Result(Array.Empty<Entry>(), markdown);
        var firstLine = markdown[..firstLineEnd].TrimEnd('\r');
        if (firstLine != "---") return new Result(Array.Empty<Entry>(), markdown);

        var rest = markdown[(firstLineEnd + 1)..];
        // Schlusszeile: alleinstehendes ---. Suche zeilenweise.
        var lines = rest.Split('\n');
        int closeIdx = -1;
        for (int i = 0; i < lines.Length; i++)
        {
            if (lines[i].TrimEnd('\r') == "---")
            {
                closeIdx = i;
                break;
            }
        }
        if (closeIdx < 0) return new Result(Array.Empty<Entry>(), markdown);

        var entries = new List<Entry>();
        for (int i = 0; i < closeIdx; i++)
        {
            var line = lines[i].TrimEnd('\r');
            if (string.IsNullOrWhiteSpace(line)) continue;
            // Zeilen die mit Whitespace beginnen: Fortsetzungs-/Listen-Items, derzeit ignoriert.
            if (char.IsWhiteSpace(line[0])) continue;
            // Kommentare in YAML
            if (line.TrimStart().StartsWith('#')) continue;
            var colon = line.IndexOf(':');
            if (colon <= 0) continue;
            var key = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim();
            value = NormalizeValue(value);
            entries.Add(new Entry(key, value));
        }

        // Body-Offset: alle vor Schluss-Zeile + Schluss-Zeile.
        int consumed = 0;
        for (int i = 0; i <= closeIdx; i++) consumed += lines[i].Length + 1; // +1 fuer den \n
        if (consumed > rest.Length) consumed = rest.Length;
        var body = rest[consumed..];
        // Fuehrende Leerzeile nach dem Frontmatter-Block ist optional, lassen wir stehen.

        return new Result(entries, body);
    }

    private static string NormalizeValue(string raw)
    {
        if (raw.Length >= 2)
        {
            if ((raw[0] == '"' && raw[^1] == '"') || (raw[0] == '\'' && raw[^1] == '\''))
                return raw[1..^1];
            if (raw[0] == '[' && raw[^1] == ']')
            {
                var inner = raw[1..^1];
                var parts = inner.Split(',');
                var sb = new StringBuilder();
                for (int i = 0; i < parts.Length; i++)
                {
                    var p = parts[i].Trim();
                    if (p.Length >= 2 && ((p[0] == '"' && p[^1] == '"') || (p[0] == '\'' && p[^1] == '\'')))
                        p = p[1..^1];
                    if (p.Length == 0) continue;
                    if (sb.Length > 0) sb.Append(", ");
                    sb.Append(p);
                }
                return sb.ToString();
            }
        }
        return raw;
    }

    public static string RenderHtml(IReadOnlyList<Entry> entries)
    {
        if (entries.Count == 0) return string.Empty;
        var sb = new StringBuilder();
        sb.Append("<aside class=\"frontmatter\"><dl>");
        foreach (var e in entries)
        {
            sb.Append("<dt>").Append(WebUtility.HtmlEncode(e.Key)).Append("</dt>");
            sb.Append("<dd>").Append(WebUtility.HtmlEncode(e.Value)).Append("</dd>");
        }
        sb.Append("</dl></aside>");
        return sb.ToString();
    }
}
