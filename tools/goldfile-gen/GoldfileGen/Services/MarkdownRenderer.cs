using System.IO;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using Markdig;

namespace Folio.Services;

public sealed class MarkdownRenderer
{
    public const string VirtualHostName = "folio.local";

    private readonly MarkdownPipeline _pipeline;
    private readonly string _template;
    private readonly string _editorBundle;

    public MarkdownRenderer()
    {
        _pipeline = MarkdownPipelineFactory.Default;
        _template = LoadTemplate();
        _editorBundle = LoadEditorBundle();
    }

    public string RenderFile(string absolutePath, string themeClass = "theme-light",
        string tocEntriesHtml = "", double tocWidth = 260, string bodyClass = "",
        string vaultTreeHtml = "", double vaultWidth = 240)
    {
        var markdown = File.ReadAllText(absolutePath, Encoding.UTF8);
        // Base href zeigt auf die Datei selbst, sonst brechen #section-Anker.
        var baseHref = new Uri(absolutePath).AbsoluteUri;
        var baseDir = Path.GetDirectoryName(absolutePath);
        return Render(markdown, baseHref, Path.GetFileName(absolutePath), baseDir, themeClass,
            tocEntriesHtml, tocWidth, bodyClass, vaultTreeHtml, vaultWidth);
    }

    public string Render(string markdown, string baseHref, string title,
        string? baseDir = null, string themeClass = "theme-light",
        string tocEntriesHtml = "", double tocWidth = 260, string bodyClass = "",
        string vaultTreeHtml = "", double vaultWidth = 240)
    {
        var fm = FrontmatterExtractor.Extract(markdown);
        var preprocessed = HeadingAnchorPreprocessor.ConvertInlineAnchorsInHeadings(fm.Body);
        var body = Markdown.ToHtml(preprocessed, _pipeline);
        var frontmatterHtml = FrontmatterExtractor.RenderHtml(fm.Entries);
        var tocWidthLiteral = tocWidth.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var vaultWidthLiteral = vaultWidth.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var html = _template
            .Replace("{{BASE_HREF}}", WebUtility.HtmlEncode(baseHref))
            .Replace("{{TITLE}}", WebUtility.HtmlEncode(title))
            .Replace("{{THEME_CLASS}}", WebUtility.HtmlEncode(themeClass))
            .Replace("{{CONTENT}}", frontmatterHtml + body)
            .Replace("{{TOC_ENTRIES}}", tocEntriesHtml)
            .Replace("{{TOC_WIDTH}}", tocWidthLiteral)
            .Replace("{{BODY_CLASS}}", WebUtility.HtmlEncode(bodyClass))
            .Replace("{{VAULT_TREE}}", vaultTreeHtml)
            .Replace("{{VAULT_WIDTH}}", vaultWidthLiteral)
            .Replace("{{EDITOR_BUNDLE}}", _editorBundle);
        if (!string.IsNullOrEmpty(baseDir))
            html = RewriteImages(html, baseDir);
        return html;
    }

    private static readonly Regex ImgTagRegex = new(
        @"<img\s[^>]*>",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly Regex SrcAttrRegex = new(
        @"src\s*=\s*""([^""]+)""",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    internal static string RewriteImages(string html, string baseDir)
    {
        // NavigateToString-Dokumente laufen als about:blank-Ursprung, aus dem Chromium
        // keine file://-Subresources laedt. Lokale Bilder unterhalb des Doc-Verzeichnisses
        // gehen ueber den WebView2-Virtual-Host (siehe ShellPane.UpdateVirtualHostMapping);
        // absolute Pfade ausserhalb fallen auf data:-URIs zurueck.
        var baseFull = Path.GetFullPath(baseDir);
        return ImgTagRegex.Replace(html, tagMatch =>
        {
            return SrcAttrRegex.Replace(tagMatch.Value, srcMatch =>
            {
                var src = srcMatch.Groups[1].Value;
                var replacement = TryRewriteImage(src, baseFull);
                return replacement is null ? srcMatch.Value : $"src=\"{replacement}\"";
            });
        });
    }

    private static string? TryRewriteImage(string src, string baseFull)
    {
        if (string.IsNullOrWhiteSpace(src)) return null;
        if (src.StartsWith("http://", StringComparison.OrdinalIgnoreCase)) return null;
        if (src.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) return null;
        if (src.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return null;

        try
        {
            var decoded = Uri.UnescapeDataString(src);
            string absPath;
            if (decoded.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
                absPath = new Uri(decoded).LocalPath;
            else if (Path.IsPathRooted(decoded))
                absPath = decoded;
            else
                absPath = Path.Combine(baseFull, decoded);

            absPath = Path.GetFullPath(absPath);

            if (IsUnder(absPath, baseFull))
            {
                var relative = Path.GetRelativePath(baseFull, absPath).Replace('\\', '/');
                var encoded = string.Join("/", relative.Split('/').Select(Uri.EscapeDataString));
                return $"https://{VirtualHostName}/{encoded}";
            }

            return TryInlineAsDataUri(absPath);
        }
        catch
        {
            return null;
        }
    }

    private static bool IsUnder(string absPath, string baseFull)
    {
        var baseWithSep = baseFull.EndsWith(Path.DirectorySeparatorChar)
            ? baseFull
            : baseFull + Path.DirectorySeparatorChar;
        return absPath.StartsWith(baseWithSep, StringComparison.OrdinalIgnoreCase)
            || string.Equals(absPath, baseFull, StringComparison.OrdinalIgnoreCase);
    }

    private static string? TryInlineAsDataUri(string absPath)
    {
        if (!File.Exists(absPath)) return null;
        var mime = GuessMime(Path.GetExtension(absPath));
        var bytes = File.ReadAllBytes(absPath);
        return $"data:{mime};base64,{Convert.ToBase64String(bytes)}";
    }

    private static string GuessMime(string extension) => extension.ToLowerInvariant() switch
    {
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".svg" => "image/svg+xml",
        ".webp" => "image/webp",
        ".bmp" => "image/bmp",
        ".ico" => "image/x-icon",
        ".avif" => "image/avif",
        _ => "application/octet-stream"
    };

    private static string LoadTemplate() => LoadEmbeddedText("Folio.Resources.shell-template.html");

    private static string LoadEditorBundle() => LoadEmbeddedText("Folio.Resources.editor.bundle.js");

    private static string LoadEmbeddedText(string resourceName)
    {
        var asm = Assembly.GetExecutingAssembly();
        using var stream = asm.GetManifestResourceStream(resourceName)
            ?? throw new FileNotFoundException($"Embedded resource not found: {resourceName}");
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }
}
