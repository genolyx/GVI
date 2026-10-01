/** PUT a file and report loaded bytes. fetch() cannot see upload progress. */
export function putFileWithProgress(
  url: string,
  file: File,
  onProgress: (loaded: number, total: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(file.size, file.size);
        resolve();
        return;
      }
      reject(new Error(`Upload failed for ${file.name}`));
    };
    xhr.onerror = () => {
      reject(new Error(`Upload failed for ${file.name}. The browser could not reach storage.`));
    };
    xhr.onabort = () => reject(new Error(`Upload cancelled for ${file.name}`));
    xhr.send(file);
  });
}
