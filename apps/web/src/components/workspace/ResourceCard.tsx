import React, { useState } from 'react';
import type { LearningResourceDto } from '@peerlume/shared';
import {
  FileText,
  Link as LinkIcon,
  Code,
  Download,
  Copy,
  Check,
  Trash2,
  Edit2,
  Lock,
  Globe,
  Calendar,
  ExternalLink,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext.js';
import { apiService } from '../../services/api.js';

interface ResourceCardProps {
  resource: LearningResourceDto;
  onEdit?: (resource: LearningResourceDto) => void;
  onDelete?: (resourceId: string) => void;
}

export const ResourceCard: React.FC<ResourceCardProps> = ({
  resource,
  onEdit,
  onDelete,
}) => {
  const { user } = useAuth();
  const isOwner = user?.id === resource.creatorId;
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (downloading) return;
    setDownloading(true);
    try {
      await apiService.resources.downloadResource(resource.id, resource.fileName || 'document');
    } finally {
      setDownloading(false);
    }
  };

  const handleCopyCode = async () => {
    if (!resource.content) return;
    try {
      await navigator.clipboard.writeText(resource.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  const formattedDate = new Date(resource.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const formatFileSize = (bytes?: number | null) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const typeConfig: Record<
    string,
    { label: string; icon: React.ReactNode; color: string; border: string; bg: string }
  > = {
    NOTE: {
      label: 'Note',
      icon: <FileText className="w-3.5 h-3.5" />,
      color: 'text-foreground',
      border: 'border-border',
      bg: 'bg-surface',
    },
    LINK: {
      label: 'Link',
      icon: <LinkIcon className="w-3.5 h-3.5" />,
      color: 'text-foreground',
      border: 'border-border',
      bg: 'bg-surface',
    },
    CODE: {
      label: 'Code Snippet',
      icon: <Code className="w-3.5 h-3.5" />,
      color: 'text-foreground',
      border: 'border-border',
      bg: 'bg-surface',
    },
    DOCUMENT: {
      label: 'Document',
      icon: <Download className="w-3.5 h-3.5" />,
      color: 'text-foreground',
      border: 'border-border',
      bg: 'bg-surface',
    },
  };

  const config = typeConfig[resource.type] || typeConfig.NOTE;

  return (
    <div className="bg-card border border-border rounded-xl p-5 hover:border-border-strong hover:shadow-md hover:-translate-y-1 transition-all duration-200 flex flex-col justify-between gap-4 shadow-xs group">
      <div className="space-y-3">
        {/* Header: Type Badge, Title, Privacy, Action icons */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${config.bg} ${config.color} border ${config.border}`}
            >
              {config.icon}
              <span>{config.label}</span>
            </span>

            {resource.isPrivate ? (
              <span className="inline-flex items-center gap-1 text-[11px] text-foreground-muted bg-surface border border-border-subtle px-2 py-0.5 rounded-full">
                <Lock className="w-3 h-3 text-foreground-muted" />
                <span>Private</span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] text-foreground-secondary bg-surface border border-border-subtle px-2 py-0.5 rounded-full">
                <Globe className="w-3 h-3 text-foreground-muted" />
                <span>Shared</span>
              </span>
            )}
          </div>

          {isOwner && (
            <div className="flex items-center gap-1">
              {onEdit && (
                <button
                  onClick={() => onEdit(resource)}
                  aria-label="Edit resource"
                  className="p-1.5 text-foreground-muted hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
                >
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
              )}
              {onDelete && (
                <button
                  onClick={() => onDelete(resource.id)}
                  aria-label="Delete resource"
                  className="p-1.5 text-foreground-muted hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Title & Description */}
        <div>
          <h3 className="text-base font-semibold text-foreground mb-1">{resource.title}</h3>
          {resource.description && (
            <p className="text-xs text-foreground-secondary leading-relaxed">{resource.description}</p>
          )}
        </div>

        {/* Content Type Variations */}

        {/* 1. Note Content */}
        {resource.type === 'NOTE' && resource.content && (
          <div className="bg-surface border border-border-subtle rounded-lg p-3.5 text-xs text-foreground-secondary font-sans leading-relaxed whitespace-pre-wrap max-h-48 overflow-y-auto">
            {resource.content}
          </div>
        )}

        {/* 2. Link Resource */}
        {resource.type === 'LINK' && resource.url && (
          <div className="bg-surface border border-border-subtle rounded-lg p-3 flex items-center justify-between gap-3">
            <div className="truncate min-w-0">
              <span className="text-xs text-foreground-secondary font-medium truncate block font-mono">
                {resource.url}
              </span>
            </div>
            <a
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-foreground bg-surface-elevated hover:bg-surface-hover px-2.5 py-1 rounded-lg border border-border shrink-0 transition-colors"
            >
              <span>Visit</span>
              <ExternalLink className="w-3 h-3 text-foreground-muted" />
            </a>
          </div>
        )}

        {/* 3. Code Snippet */}
        {resource.type === 'CODE' && resource.content && (
          <div className="relative group">
            <div className="flex items-center justify-between bg-surface px-3 py-1.5 rounded-t-lg border border-b-0 border-border text-[11px] text-foreground-muted">
              <span className="font-mono uppercase font-semibold text-foreground">
                {resource.language || 'code'}
              </span>
              <button
                onClick={handleCopyCode}
                className="flex items-center gap-1 text-[11px] text-foreground-muted hover:text-foreground transition-colors"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? 'Copied!' : 'Copy'}</span>
              </button>
            </div>
            <pre className="bg-surface border border-border rounded-b-lg p-3.5 text-xs font-mono text-foreground-secondary overflow-x-auto whitespace-pre leading-relaxed max-h-48">
              <code>{resource.content}</code>
            </pre>
          </div>
        )}

        {/* 4. Document / File Attachment */}
        {resource.type === 'DOCUMENT' && (
          <div className="bg-surface border border-border-subtle rounded-lg p-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="p-2 rounded-lg bg-surface-elevated text-foreground border border-border shrink-0">
                <Download className="w-4 h-4" />
              </div>
              <div className="min-w-0">
                <span className="text-xs font-medium text-foreground truncate block">
                  {resource.fileName || 'Attached Document'}
                </span>
                <span className="text-[10px] text-foreground-muted block">
                  {formatFileSize(resource.fileSize)} • {resource.mimeType || 'file'}
                </span>
              </div>
            </div>

            <a
              href={apiService.resources.getDownloadUrl(resource.id)}
              onClick={handleDownload}
              download={resource.fileName || 'document'}
              className="inline-flex items-center gap-1 text-xs text-foreground bg-surface-elevated hover:bg-surface-hover px-3 py-1.5 rounded-lg border border-border shrink-0 transition-colors font-medium cursor-pointer"
            >
              <Download className={`w-3.5 h-3.5 text-foreground-muted ${downloading ? 'animate-bounce' : ''}`} />
              <span>{downloading ? 'Downloading...' : 'Download'}</span>
            </a>
          </div>
        )}
      </div>

      {/* Footer Info: Creator & Session info */}
      <div className="flex items-center justify-between pt-2 border-t border-border-subtle text-[11px] text-foreground-muted">
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded-full bg-foreground text-background flex items-center justify-center text-[9px] font-bold">
            {resource.creatorName.charAt(0)}
          </div>
          <span>{isOwner ? 'Created by you' : resource.creatorName}</span>
        </div>

        <div className="flex items-center gap-3">
          {resource.sessionTitle && (
            <span className="inline-flex items-center gap-1 text-foreground-muted" title={`Associated with session: ${resource.sessionTitle}`}>
              <Calendar className="w-3 h-3 text-foreground-muted" />
              <span className="truncate max-w-[120px]">{resource.sessionTitle}</span>
            </span>
          )}
          <span>{formattedDate}</span>
        </div>
      </div>
    </div>
  );
};
