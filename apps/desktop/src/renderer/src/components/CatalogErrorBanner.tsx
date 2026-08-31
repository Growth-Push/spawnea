import React, { useState } from 'react';
import type { CatalogValidationError, OperationalCatalog } from '@spawnea/domain';
import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react';

interface CatalogErrorBannerProps {
  errors: CatalogValidationError[];
  activeCatalog: OperationalCatalog | null;
  onReload: () => void;
  isReloading?: boolean;
}

export function CatalogErrorBanner({
  errors,
  activeCatalog,
  onReload,
  isReloading = false,
}: CatalogErrorBannerProps): React.JSX.Element | null {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  if (errors.length === 0 || isDismissed) {
    return null;
  }

  const hasFallback = activeCatalog !== null;

  return (
    <div
      data-testid="catalog-error-banner"
      className="bg-amber-950/40 border-b border-amber-500/30 text-amber-200 px-4 py-2.5 shrink-0 transition-all"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-2 text-xs truncate">
            <span className="font-semibold text-amber-300">
              {hasFallback ? 'Catalog Reload Rejected:' : 'Catalog Validation Error:'}
            </span>
            <span className="text-amber-200/90 truncate">
              {hasFallback
                ? `${errors.length} error(s) found in candidate YAML. Last valid catalog remains active.`
                : `${errors.length} error(s) found. Fix the catalog file to enable session creation.`}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            data-testid="banner-reload-catalog-button"
            onClick={onReload}
            disabled={isReloading}
            className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 rounded text-xs font-medium text-amber-200 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isReloading ? 'animate-spin' : ''}`} />
            <span>Reload Config</span>
          </button>

          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 hover:bg-amber-500/20 rounded text-amber-300 hover:text-white transition-colors cursor-pointer"
            title={isExpanded ? 'Hide error details' : 'Show error details'}
          >
            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>

          <button
            type="button"
            onClick={() => setIsDismissed(true)}
            className="p-1 hover:bg-amber-500/20 rounded text-amber-400 hover:text-white transition-colors cursor-pointer"
            title="Dismiss banner"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="mt-2.5 pt-2 border-t border-amber-500/20 space-y-1.5 font-mono text-[11px]">
          {errors.map((err, idx) => (
            <div key={`${err.path}-${idx}`} className="flex items-start gap-2 bg-black/30 px-2.5 py-1.5 rounded">
              <span className="text-amber-400 font-semibold shrink-0">[{err.path}]:</span>
              <span className="text-zinc-300 break-all">{err.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
