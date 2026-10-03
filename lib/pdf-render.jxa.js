// Renders PDF pages, or regions of them, to PNG with macOS PDFKit (built into macOS, no extra tools).
// Used by the PowerPoint import: each slide was exported as one PDF page.
//   osascript -l JavaScript pdf-render.jxa.js <jobs.json>
// jobs.json: { "pdf": "/path/deck.pdf", "slideWidth": 1280, "jobs": [
//   { "page": 1, "out": "/path/page-1.png", "width": 640 },                       // whole page
//   { "page": 4, "out": "/path/fig.png", "box": [x, y, w, h], "scale": 2 } ] }      // region, in slide px
// Prints the number of pages of the PDF.
ObjC.import("PDFKit");
ObjC.import("AppKit");
function run(argv) {
  const spec = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null)));
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(spec.pdf));
  if (!doc || doc.isNil()) throw new Error("Cannot open " + spec.pdf);
  for (const job of spec.jobs || []) {
    const page = doc.pageAtIndex(job.page - 1);
    if (!page || page.isNil()) continue;
    const pb = page.boundsForBox($.kPDFDisplayBoxMediaBox);
    const pw = pb.size.width, ph = pb.size.height;
    const f = pw / (spec.slideWidth || 1280);            // PDF points per slide px
    let w, h, scale, tx, ty;
    if (job.box) {
      const [x, y, bw, bh] = job.box;
      scale = (job.scale || 2) / f;                       // output px per PDF point
      w = Math.max(1, Math.round(bw * (job.scale || 2))); h = Math.max(1, Math.round(bh * (job.scale || 2)));
      tx = -x * f; ty = -(ph - (y + bh) * f);             // PDF y runs upwards
    } else {
      scale = (job.width || 1280) / pw;
      w = Math.round(pw * scale); h = Math.round(ph * scale); tx = 0; ty = 0;
    }
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, w, h, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    const ctx = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.currentContext = ctx;
    $.NSColor.whiteColor.setFill;
    $.NSRectFill($.NSMakeRect(0, 0, w, h));
    const cg = ctx.CGContext;
    $.CGContextScaleCTM(cg, scale, scale);
    $.CGContextTranslateCTM(cg, tx, ty);
    page.drawWithBoxToContext($.kPDFDisplayBoxMediaBox, cg);
    ctx.flushGraphics;
    $.NSGraphicsContext.restoreGraphicsState;
    rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(job.out, true);
  }
  return String(doc.pageCount);
}
