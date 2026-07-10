import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import type { ReferenceImageSnapshot } from "../../core/sourceImage";
import { referenceImageDataUrl, validateAndReadImage } from "./imageFile";

interface ImageUploadProps {
  value?: ReferenceImageSnapshot;
  onChange: (image?: ReferenceImageSnapshot) => void;
}

export function ImageUpload({ value, onChange }: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function acceptFile(file?: File) {
    if (!file) return;
    setLoading(true);
    setError("");
    try {
      onChange(await validateAndReadImage(file));
    } catch (uploadError) {
      onChange(undefined);
      setError(uploadError instanceof Error ? uploadError.message : "图片不可用。" );
    } finally {
      setLoading(false);
    }
  }

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    void acceptFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    void acceptFile(event.dataTransfer.files?.[0]);
  }

  return (
    <div className="upload-section">
      <div
        className="upload-zone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        {value ? (
          <>
            <img src={referenceImageDataUrl(value)} alt="已选择的参考图片" />
            <div>
              <strong>{value.name}</strong>
              <p>
                {value.width} × {value.height} · {(value.size / 1024 / 1024).toFixed(2)} MB
              </p>
            </div>
          </>
        ) : (
          <p>{loading ? "正在解析图片…" : "拖放图片到这里，或点击选择 PNG、JPEG、WebP"}</p>
        )}
      </div>
      <input ref={inputRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={onInput} />
      <div className="button-row">
        <button className="button" type="button" onClick={() => inputRef.current?.click()} disabled={loading}>
          {value ? "替换图片" : "选择图片"}
        </button>
        {value && (
          <button className="button danger" type="button" onClick={() => onChange(undefined)}>
            删除图片
          </button>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
