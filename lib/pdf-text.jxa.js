ObjC.import('Foundation');
ObjC.import('PDFKit');
function run(argv) {
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  const page = Number(argv[1]) - 1;
  if (!doc || page < 0 || page >= Number(doc.pageCount)) throw new Error('Invalid PDF page.');
  const s = doc.pageAtIndex(page).string;
  return s ? ObjC.unwrap(s) : '';
}
