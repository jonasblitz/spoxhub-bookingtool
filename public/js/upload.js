/**
 * File Upload — Drag & Drop + Vorschau + State
 */

let uploadedFiles = [];

function initUploadDropzone() {
  const dropzone = document.getElementById('upload-dropzone');
  if (!dropzone) return;

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    handleFileSelect(e.dataTransfer.files);
  });
}

async function handleFileSelect(fileList) {
  if (!fileList || fileList.length === 0) return;

  const files = Array.from(fileList);
  const maxSize = 20 * 1024 * 1024;

  for (const file of files) {
    if (file.size > maxSize) {
      alert(`"${file.name}" ist zu groß (max. 20 MB).`);
      continue;
    }
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      alert(`"${file.name}" ist kein unterstütztes Format.`);
      continue;
    }
    await uploadFile(file);
  }

  // Clear input so same file can be re-selected
  const input = document.getElementById('file-input');
  if (input) input.value = '';
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('files', file);

  // Show uploading state
  const tempId = 'upload-' + Date.now();
  addPreviewItem(tempId, file.name, file.type, null, true);

  try {
    const res = await fetch(API_BASE + '/api/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();

    if (!res.ok) {
      removePreviewItem(tempId);
      alert(data.error || 'Upload fehlgeschlagen.');
      return;
    }

    const uploaded = data.files[0];
    // Replace temp with real preview
    removePreviewItem(tempId);
    addPreviewItem(uploaded.filename, uploaded.originalName, uploaded.type, uploaded.url, false);

    uploadedFiles.push(uploaded);
    BookingState.set('uploadedFiles', uploadedFiles);
  } catch (err) {
    console.error('Upload error:', err);
    removePreviewItem(tempId);
    alert('Upload fehlgeschlagen. Bitte versuche es erneut.');
  }
}

function addPreviewItem(id, name, type, url, isLoading) {
  const container = document.getElementById('upload-preview');
  if (!container) return;
  container.classList.remove('hidden');

  const item = document.createElement('div');
  item.className = 'upload-item';
  item.id = `preview-${id}`;

  if (isLoading) {
    item.innerHTML = `
      <div class="upload-item__thumb upload-item__loading">
        <span class="inline-block w-5 h-5 border-2 border-text-muted border-t-transparent rounded-full animate-spin"></span>
      </div>
      <span class="upload-item__name">${escapeHtml(name)}</span>
    `;
  } else if (type.startsWith('image/')) {
    const imgSrc = url.startsWith('http') ? url : API_BASE + url;
    item.innerHTML = `
      <img src="${imgSrc}" alt="${escapeHtml(name)}" class="upload-item__thumb">
      <span class="upload-item__name">${escapeHtml(name)}</span>
      <button type="button" class="upload-item__remove" onclick="removeUpload('${id}')" title="Entfernen">&times;</button>
    `;
  } else {
    item.innerHTML = `
      <div class="upload-item__thumb upload-item__video">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </div>
      <span class="upload-item__name">${escapeHtml(name)}</span>
      <button type="button" class="upload-item__remove" onclick="removeUpload('${id}')" title="Entfernen">&times;</button>
    `;
  }

  container.appendChild(item);
}

function removePreviewItem(id) {
  const el = document.getElementById(`preview-${id}`);
  if (el) el.remove();

  const container = document.getElementById('upload-preview');
  if (container && container.children.length === 0) {
    container.classList.add('hidden');
  }
}

async function removeUpload(filename) {
  try {
    await fetch(API_BASE + '/api/upload/' + filename, { method: 'DELETE' });
  } catch (e) { /* ignore */ }

  uploadedFiles = uploadedFiles.filter(f => f.filename !== filename);
  BookingState.set('uploadedFiles', uploadedFiles);
  removePreviewItem(filename);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ═══════════════════════════════════════════
// Show problem-details section when services are selected
BookingState.subscribe((key) => {
  if (key === 'selectedServices') {
    const details = document.getElementById('problem-details');
    const services = BookingState.get('selectedServices') || [];
    if (details) {
      details.classList.toggle('hidden', services.length === 0);
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  initUploadDropzone();

  // Restore problem uploads
  const saved = BookingState.get('uploadedFiles');
  if (Array.isArray(saved) && saved.length > 0) {
    uploadedFiles = saved;
    saved.forEach(f => addPreviewItem(f.filename, f.originalName, f.type, f.url, false));
  }

  const desc = BookingState.get('problemDescription');
  if (desc) {
    const el = document.getElementById('problem-description');
    if (el) el.value = desc;
  }

  // Show section if services already selected
  const services = BookingState.get('selectedServices') || [];
  const details = document.getElementById('problem-details');
  if (details && services.length > 0) {
    details.classList.remove('hidden');
  }
});
