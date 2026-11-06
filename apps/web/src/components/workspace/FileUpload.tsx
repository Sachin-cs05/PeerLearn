import React, { useState } from 'react';
import type { LearningResourceDto, CreateResourceInput } from '@peerlume/shared';
import { apiService } from '../../services/api.js';
import { Button } from '../ui/Button.js';
import { Alert } from '../ui/Alert.js';
import { Upload, Lock, Globe } from 'lucide-react';

interface FileUploadProps {
  sessionId?: string;
  onSuccess: (resource: LearningResourceDto) => void;
  onCancel: () => void;
}

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

export const FileUpload: React.FC<FileUploadProps> = ({
  sessionId,
  onSuccess,
  onCancel,
}) => {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const selected = e.target.files?.[0];
    if (!selected) return;

    if (selected.size > MAX_FILE_SIZE) {
      setError('File size exceeds the 15MB limit.');
      return;
    }

    setFile(selected);
    if (!title.trim()) {
      // Auto-populate title with file name without extension
      const nameParts = selected.name.split('.');
      if (nameParts.length > 1) nameParts.pop();
      setTitle(nameParts.join('.'));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!file) {
      setError('Please select a file to upload');
      return;
    }
    if (!title.trim()) {
      setError('Resource title is required');
      return;
    }

    const input: CreateResourceInput = {
      type: 'DOCUMENT',
      title: title.trim(),
      description: description.trim() || undefined,
      isPrivate,
      sessionId,
    };

    setUploading(true);
    setUploadProgress(0);
    try {
      const res = await apiService.resources.create(input, file, (pct) => {
        setUploadProgress(pct);
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      if (res.data) {
        onSuccess(res.data);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to upload document');
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && <Alert variant="error">{error}</Alert>}

      {/* Drag & Drop File Input */}
      <div>
        <label className="block text-xs font-semibold text-foreground mb-1.5">
          Select Document or PDF (Max 15MB) *
        </label>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const dropped = e.dataTransfer.files?.[0];
            if (dropped) {
              if (dropped.size > MAX_FILE_SIZE) {
                setError('File size exceeds the 15MB limit.');
                return;
              }
              setFile(dropped);
              if (!title.trim()) {
                const nameParts = dropped.name.split('.');
                if (nameParts.length > 1) nameParts.pop();
                setTitle(nameParts.join('.'));
              }
            }
          }}
          className={`border-2 border-dashed rounded-xl p-6 text-center transition-all duration-200 group ${
            isDragging
              ? 'border-foreground bg-surface-hover scale-[1.01] shadow-md'
              : 'border-border hover:border-foreground/50 bg-surface'
          }`}
        >
          <input
            type="file"
            id="workspace-file"
            className="hidden"
            onChange={handleFileChange}
            accept=".pdf,.doc,.docx,.txt,.md,.json,.zip,.png,.jpg,.jpeg"
          />
          <label htmlFor="workspace-file" className="cursor-pointer block">
            <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-surface-elevated border border-border text-foreground flex items-center justify-center transition-transform duration-200 group-hover:-translate-y-0.5">
              <Upload className="w-6 h-6" />
            </div>
            {file ? (
              <div className="space-y-1">
                <span className="text-sm font-semibold text-foreground block truncate max-w-sm mx-auto">
                  {file.name}
                </span>
                <span className="text-xs text-foreground-muted block">
                  {(file.size / (1024 * 1024)).toFixed(2)} MB • Click to change file
                </span>
              </div>
            ) : (
              <div className="space-y-1">
                <span className="text-sm font-semibold text-foreground block">
                  Click to browse or drop file here
                </span>
                <span className="text-xs text-foreground-muted block">
                  PDF, DOCX, TXT, JSON, ZIP, PNG up to 15MB
                </span>
              </div>
            )}
          </label>
        </div>
      </div>

      {/* Title */}
      <div>
        <label className="block text-xs font-semibold text-foreground mb-1">
          Document Title *
        </label>
        <input
          type="text"
          required
          placeholder="e.g., Midterm Study Guide PDF"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full bg-surface border border-border rounded-lg px-3.5 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-foreground transition-colors"
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-xs font-semibold text-foreground mb-1">
          Description
        </label>
        <input
          type="text"
          placeholder="e.g., Lecture notes and solved formula sheets for exam"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full bg-surface border border-border rounded-lg px-3.5 py-2 text-sm text-foreground placeholder-foreground-muted focus:outline-none focus:border-foreground transition-colors"
        />
      </div>

      {/* Privacy Switch */}
      <div className="flex items-center justify-between bg-surface border border-border rounded-xl p-3.5">
        <div className="flex items-center gap-2.5">
          {isPrivate ? (
            <Lock className="w-4 h-4 text-foreground-muted" />
          ) : (
            <Globe className="w-4 h-4 text-foreground-muted" />
          )}
          <div>
            <div className="text-xs font-semibold text-foreground">
              {isPrivate ? 'Private File' : 'Shared with Session / Partners'}
            </div>
            <div className="text-[11px] text-foreground-muted">
              {isPrivate ? 'Only you can download this file' : 'Accessible to authorized session partners'}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsPrivate(!isPrivate)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none border border-border ${
            isPrivate ? 'bg-surface-elevated' : 'bg-foreground'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full transition-transform ${
              isPrivate ? 'translate-x-1 bg-foreground-muted' : 'translate-x-6 bg-background'
            }`}
          />
        </button>
      </div>

      {/* Upload Progress Bar */}
      {uploading && uploadProgress !== null && (
        <div className="space-y-1.5 bg-surface border border-border rounded-xl p-3">
          <div className="flex items-center justify-between text-xs font-medium text-foreground">
            <span>Uploading document...</span>
            <span className="font-mono">{uploadProgress}%</span>
          </div>
          <div className="w-full bg-surface-elevated rounded-full h-1.5 overflow-hidden border border-border">
            <div
              className="bg-foreground h-full transition-all duration-150 ease-out rounded-full"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {/* Footer Actions */}
      <div className="flex items-center justify-end gap-3 pt-3 border-t border-border">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={uploading}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" isLoading={uploading} leftIcon={<Upload className="w-4 h-4" />}>
          {uploading ? (uploadProgress !== null ? `Uploading (${uploadProgress}%)...` : 'Uploading...') : 'Upload & Share'}
        </Button>
      </div>
    </form>
  );
};
