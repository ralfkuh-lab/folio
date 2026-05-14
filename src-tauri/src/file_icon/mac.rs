use super::IconBytes;

pub(super) fn compute_icon(ext: &str) -> Option<IconBytes> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSString};

    unsafe {
        let workspace = NSWorkspace::sharedWorkspace();
        let ext_str = NSString::from_str(ext);

        #[allow(deprecated)]
        let image = workspace.iconForFileType(&ext_str);

        let tiff = image.TIFFRepresentation()?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;

        let dict = NSDictionary::new();
        let png_data =
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &dict)?;

        Some(IconBytes {
            bytes: png_data.to_vec(),
            mime: "image/png",
        })
    }
}
