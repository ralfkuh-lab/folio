using Markdig;

namespace Folio.Services;

internal static class MarkdownPipelineFactory
{
    public static MarkdownPipeline Default { get; } = new MarkdownPipelineBuilder()
        .UseAdvancedExtensions()
        .UseAutoIdentifiers()
        .DisableHtml()
        .Build();
}
