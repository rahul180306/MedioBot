import React from 'react';
import { ApprovalRequestData } from '../../types';
import { ShieldAlert, Check, X, ShieldCheck } from 'lucide-react';
import { useApp } from '../../state/AppContext';

export const ApprovalBanner: React.FC<{
  approval: ApprovalRequestData;
  turnId: string;
}> = ({ approval, turnId }) => {
  const { respondApproval } = useApp();

  const isPending = approval.status === 'pending';
  const isApproved = approval.status === 'approved';
  const isRejected = approval.status === 'rejected';

  return (
    <div className="my-3 p-3.5 rounded-xl border border-amber-500/30 bg-amber-500/5 text-xs text-neutral-200">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <div className="p-1 rounded-md bg-amber-500/10 text-amber-400 shrink-0 mt-0.5">
            {isApproved ? (
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
            ) : (
              <ShieldAlert className="w-4 h-4" />
            )}
          </div>

          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-neutral-100">{approval.title}</span>
              <span className="text-[10px] text-neutral-400 font-mono">
                [{approval.risk.toUpperCase()} RISK]
              </span>
            </div>
            <p className="text-neutral-300 leading-relaxed">{approval.description}</p>

            {approval.actionPayload && (
              <div className="mt-1.5 px-2.5 py-1 bg-[#141417] border border-[#2b2b32] rounded font-mono text-[11px] text-neutral-300">
                {approval.actionPayload.detail}
              </div>
            )}
          </div>
        </div>

        {/* Action Controls */}
        <div className="shrink-0 flex items-center gap-2 self-start mt-0.5">
          {isPending ? (
            <>
              <button
                onClick={() => respondApproval(turnId, approval.approvalId, false)}
                className="px-2.5 py-1.5 rounded-md text-xs font-medium text-neutral-300 hover:text-white hover:bg-neutral-800 border border-neutral-700 transition-colors flex items-center gap-1"
              >
                <X className="w-3.5 h-3.5" />
                <span>Reject</span>
              </button>

              <button
                onClick={() => respondApproval(turnId, approval.approvalId, true)}
                className="px-3 py-1.5 rounded-md text-xs font-medium text-neutral-900 bg-neutral-100 hover:bg-white shadow transition-colors flex items-center gap-1"
              >
                <Check className="w-3.5 h-3.5" />
                <span>Approve</span>
              </button>
            </>
          ) : isApproved ? (
            <span className="text-xs font-medium text-emerald-400 flex items-center gap-1">
              <Check className="w-3.5 h-3.5" />
              <span>Approved</span>
            </span>
          ) : (
            <span className="text-xs font-medium text-rose-400 flex items-center gap-1">
              <X className="w-3.5 h-3.5" />
              <span>Rejected</span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
