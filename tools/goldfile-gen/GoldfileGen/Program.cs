using System.Text;
using Markdig;
using Folio.Services;

if (args.Length < 1)
{
    Console.Error.WriteLine("Usage: GoldfileGen <path-to-md-file>");
    Environment.Exit(1);
}

var path = args[0];
var markdown = File.ReadAllText(path, Encoding.UTF8);

var fm = FrontmatterExtractor.Extract(markdown);
var preprocessed = HeadingAnchorPreprocessor.ConvertInlineAnchorsInHeadings(fm.Body);

var pipeline = new MarkdownPipelineBuilder()
    .UseAdvancedExtensions()
    .UseAutoIdentifiers()
    .DisableHtml()
    .Build();

var body = Markdown.ToHtml(preprocessed, pipeline);
var frontmatterHtml = FrontmatterExtractor.RenderHtml(fm.Entries);

Console.WriteLine(frontmatterHtml + body);
