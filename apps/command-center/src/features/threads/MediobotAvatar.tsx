import React from 'react';
import type { ConversationActor } from '../../types';
import { getMediobotPresentation } from '../mediobots/presentation';

export const MediobotAvatar: React.FC<{
  actor?: ConversationActor;
  size?: 'xs' | 'sm' | 'md';
  working?: boolean;
}> = ({ actor, size = 'sm', working = false }) => {
  if (actor?.type !== 'mediobot') return null;
  const presentation = getMediobotPresentation(actor.presentationId ?? actor.mediobotId, actor.name);
  const dimensions = size === 'md' ? 'h-5 w-5' : size === 'xs' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const eye = size === 'md' ? 'h-[7px] w-[2.2px]' : size === 'xs' ? 'h-[5px] w-[1.5px]' : 'h-[6px] w-[1.8px]';
  const gap = size === 'md' ? 'gap-[2px]' : size === 'xs' ? 'gap-[1.2px]' : 'gap-[1.5px]';
  return (
    <span aria-hidden="true" data-testid={`actor-avatar-${presentation.id}`}
      className={`${dimensions} ${presentation.avatar} inline-flex shrink-0 items-center justify-center ${gap} rounded-full shadow-xs`}>
      <span className={`${eye} rounded-full ${presentation.eye} animate-eye-blink block`} />
      <span className={`${eye} rounded-full ${presentation.eye} animate-eye-blink block`} />
    </span>
  );
};
