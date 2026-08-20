const ARCHIVE_FOLDER_ID = '1VgZA9Y1P6w5GafKDQPgXTZ-XpfpzBtsc';  // 專門放這些頁面的資料夾

function doGet(e) {
  const segments = (e.parameter.p || '').split('/').filter((s) => s !== '');
  const fileName = segments.pop();

  const folder = segments.reduce((acc, name) => {
    let next = null;
    if (acc !== null) {
      const subs = acc.getFoldersByName(name);
      if (subs.hasNext()) {
        next = subs.next();
      }
    }
    return next;
  }, DriveApp.getFolderById(ARCHIVE_FOLDER_ID));

  let file = null;
  if (folder !== null && fileName) {
    const files = folder.getFilesByName(fileName);
    if (files.hasNext()) {
      file = files.next();
    }
  }

  let output;
  if (file === null) {
    output = HtmlService.createHtmlOutput('<h1>找不到這個頁面</h1>');
  } else {
    output = HtmlService.createHtmlOutput(file.getBlob().getDataAsString('UTF-8'))
      .setTitle(file.getName());
  }
  return output;
}
