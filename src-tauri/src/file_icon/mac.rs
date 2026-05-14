use super::IconBytes;

pub(super) fn compute_icon(ext: &str) -> Option<IconBytes> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    unsafe {
        let workspace = NSWorkspace::sharedWorkspace();
        let ext_str = NSString::from_str(ext);

        #[allow(deprecated)]
        let image = workspace.iconForFileType(&ext_str);

        // CGImage direkt aus NSImage holen — kein TIFF-Umweg nötig.
        // proposed_dest_rect=32×32 wählt die passende Auflösung aus dem
        // Multi-Res-Icon-Set (icns enthält 16/32/64/128/256/512 px).
        let mut proposed = NSRect {
            origin: NSPoint { x: 0.0, y: 0.0 },
            size: NSSize { width: 32.0, height: 32.0 },
        };
        let cg_image =
            image.CGImageForProposedRect_context_hints(&mut proposed, None, None)?;

        let rep = NSBitmapImageRep::initWithCGImage(
            objc2::AllocAnyThread::alloc(),
            &cg_image,
        );
        let dict = NSDictionary::new();
        let png_data =
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &dict)?;

        Some(IconBytes {
            bytes: png_data.to_vec(),
            mime: "image/png",
        })
    }
}
