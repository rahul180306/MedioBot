import React from 'react';
import { ExpressionEyeShape, ExpressionAnimation } from '../../types';

interface MedioBotEyeExpressionProps {
  eyeShape: ExpressionEyeShape;
  animation?: ExpressionAnimation;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  eyeColor?: string;
  delay?: string;
  className?: string;
}

export const MedioBotEyeExpression: React.FC<MedioBotEyeExpressionProps> = ({
  eyeShape,
  animation = 'blink',
  size = 'md',
  eyeColor = 'currentColor',
  delay = '0s',
  className = '',
}) => {
  // Determine animation class
  const getAnimationClass = () => {
    switch (animation) {
      case 'bounce':
        return 'animate-eye-bounce';
      case 'pulse':
        return 'animate-eye-pulse';
      case 'gaze':
        return 'animate-eye-gaze';
      case 'laser-glow':
        return 'animate-eye-laser-glow';
      case 'rapid-shimmer':
        return 'animate-eye-rapid-shimmer';
      case 'sleep-float':
        return 'animate-eye-sleep-float';
      case 'wink-cycle':
        return 'animate-eye-wink-cycle';
      case 'blink':
      default:
        return 'animate-eye-blink';
    }
  };

  const animClass = getAnimationClass();

  // Size scaling factors
  const scale = size === 'sm' ? 0.75 : size === 'lg' ? 1.4 : size === 'xl' ? 2.2 : 1;

  // Render shapes
  switch (eyeShape) {
    case 'happy':
      // Curved joyous upturned arcs (^ _ ^)
      return (
        <div
          className={`flex items-center gap-[4px] ${animClass} ${className}`}
          style={{ animationDelay: delay, color: eyeColor }}
        >
          <svg
            viewBox="0 0 16 12"
            className="overflow-visible"
            style={{ width: `${10 * scale}px`, height: `${8 * scale}px` }}
            fill="none"
          >
            <path
              d="M2 9.5C4 3 12 3 14 9.5"
              stroke="currentColor"
              strokeWidth={2.4 * scale}
              strokeLinecap="round"
            />
          </svg>
          <svg
            viewBox="0 0 16 12"
            className="overflow-visible"
            style={{ width: `${10 * scale}px`, height: `${8 * scale}px` }}
            fill="none"
          >
            <path
              d="M2 9.5C4 3 12 3 14 9.5"
              stroke="currentColor"
              strokeWidth={2.4 * scale}
              strokeLinecap="round"
            />
          </svg>
        </div>
      );

    case 'focused':
      // Sharp horizontal slits
      return (
        <div
          className={`flex items-center gap-[4px] ${animClass} ${className}`}
          style={{ animationDelay: delay, color: eyeColor }}
        >
          <span
            className="rounded-full bg-current block"
            style={{
              width: `${10 * scale}px`,
              height: `${2.6 * scale}px`,
            }}
          />
          <span
            className="rounded-full bg-current block"
            style={{
              width: `${10 * scale}px`,
              height: `${2.6 * scale}px`,
            }}
          />
        </div>
      );

    case 'surprise':
      // Wide open curious circles (O_O)
      return (
        <div
          className={`flex items-center gap-[4px] ${animClass} ${className}`}
          style={{ animationDelay: delay, color: eyeColor }}
        >
          <div
            className="rounded-full border-current flex items-center justify-center"
            style={{
              width: `${8 * scale}px`,
              height: `${8 * scale}px`,
              borderWidth: `${2 * scale}px`,
            }}
          >
            <div
              className="rounded-full bg-current"
              style={{
                width: `${2.5 * scale}px`,
                height: `${2.5 * scale}px`,
              }}
            />
          </div>
          <div
            className="rounded-full border-current flex items-center justify-center"
            style={{
              width: `${8 * scale}px`,
              height: `${8 * scale}px`,
              borderWidth: `${2 * scale}px`,
            }}
          >
            <div
              className="rounded-full bg-current"
              style={{
                width: `${2.5 * scale}px`,
                height: `${2.5 * scale}px`,
              }}
            />
          </div>
        </div>
      );

    case 'wink':
      // Left eye winking slit, right eye active thick pill
      return (
        <div
          className={`flex items-center gap-[4.5px] ${className}`}
          style={{ color: eyeColor }}
        >
          {/* Left winking eye */}
          <svg
            viewBox="0 0 16 12"
            className="overflow-visible"
            style={{ width: `${10 * scale}px`, height: `${8 * scale}px` }}
            fill="none"
          >
            <path
              d="M2 8.5C4 3.5 12 3.5 14 8.5"
              stroke="currentColor"
              strokeWidth={3.4 * scale}
              strokeLinecap="round"
            />
          </svg>
          {/* Right open eye (thick & wide) */}
          <span
            className={`rounded-full bg-current block ${animClass}`}
            style={{
              width: `${6 * scale}px`,
              height: `${13 * scale}px`,
              animationDelay: delay,
            }}
          />
        </div>
      );

    case 'sleep':
      // Peaceful horizontal sleepy slits (-_-)
      return (
        <div
          className={`flex items-center gap-[4px] ${animClass} ${className}`}
          style={{ animationDelay: delay, color: eyeColor }}
        >
          <span
            className="rounded-full bg-current block opacity-75"
            style={{
              width: `${10 * scale}px`,
              height: `${3.5 * scale}px`,
            }}
          />
          <span
            className="rounded-full bg-current block opacity-75"
            style={{
              width: `${10 * scale}px`,
              height: `${3.5 * scale}px`,
            }}
          />
        </div>
      );

    case 'hearts':
      // Passionate Heart-shaped pupils (♥_♥)
      return (
        <div
          className={`flex items-center gap-[3px] ${animClass} ${className}`}
          style={{ animationDelay: delay, color: eyeColor }}
        >
          <svg
            viewBox="0 0 24 24"
            style={{ width: `${9 * scale}px`, height: `${9 * scale}px` }}
            fill="currentColor"
          >
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
          <svg
            viewBox="0 0 24 24"
            style={{ width: `${9 * scale}px`, height: `${9 * scale}px` }}
            fill="currentColor"
          >
            <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
          </svg>
        </div>
      );

    case 'stars':
      // Sparkle diamond stars (✦_✦)
      return (
        <div
          className={`flex items-center gap-[3px] ${animClass} ${className}`}
          style={{ animationDelay: delay, color: eyeColor }}
        >
          <svg
            viewBox="0 0 24 24"
            style={{ width: `${9 * scale}px`, height: `${9 * scale}px` }}
            fill="currentColor"
          >
            <path d="M12 0L14.8 9.2L24 12L14.8 14.8L12 24L9.2 14.8L0 12L9.2 9.2L12 0Z" />
          </svg>
          <svg
            viewBox="0 0 24 24"
            style={{ width: `${9 * scale}px`, height: `${9 * scale}px` }}
            fill="currentColor"
          >
            <path d="M12 0L14.8 9.2L24 12L14.8 14.8L12 24L9.2 14.8L0 12L9.2 9.2L12 0Z" />
          </svg>
        </div>
      );

    case 'shades':
      // Cool Sunglasses Frame
      return (
        <div
          className={`flex items-center justify-center ${animClass} ${className}`}
          style={{ animationDelay: delay, color: eyeColor }}
        >
          <svg
            viewBox="0 0 32 14"
            style={{ width: `${20 * scale}px`, height: `${9 * scale}px` }}
            fill="currentColor"
          >
            <path d="M2 3h12l-1.5 8H3.5L2 3zm16 0h12l-1.5 8h-9L18 3zm-4 1.5h4v1.5h-4v-1.5z" />
          </svg>
        </div>
      );

    case 'curious':
      // Asymmetric curious eyes (o_O)
      return (
        <div
          className={`flex items-center gap-[4px] ${animClass} ${className}`}
          style={{ animationDelay: delay, color: eyeColor }}
        >
          <span
            className="rounded-full bg-current block"
            style={{
              width: `${2.8 * scale}px`,
              height: `${6 * scale}px`,
            }}
          />
          <div
            className="rounded-full border-current flex items-center justify-center"
            style={{
              width: `${7.5 * scale}px`,
              height: `${7.5 * scale}px`,
              borderWidth: `${1.8 * scale}px`,
            }}
          >
            <span
              className="rounded-full bg-current"
              style={{
                width: `${2.4 * scale}px`,
                height: `${2.4 * scale}px`,
              }}
            />
          </div>
        </div>
      );

    case 'glitch':
      // Digital Offset Glitch
      return (
        <div
          className={`flex items-center gap-[4px] relative ${animClass} ${className}`}
          style={{ animationDelay: delay, color: eyeColor }}
        >
          <span
            className="rounded-sm bg-current block"
            style={{
              width: `${5.5 * scale}px`,
              height: `${12 * scale}px`,
              transform: 'translateY(-1.5px)',
            }}
          />
          <span
            className="rounded-sm bg-current block"
            style={{
              width: `${5.5 * scale}px`,
              height: `${13 * scale}px`,
              transform: 'translateY(1.5px)',
            }}
          />
        </div>
      );

    case 'bars':
    default:
      // Signature MedioBot Classic Vertical Bars - Thick and Wide
      return (
        <div
          className={`flex items-center gap-[4.5px] ${animClass} ${className}`}
          style={{ animationDelay: delay, color: eyeColor }}
        >
          <span
            className="rounded-full bg-current block"
            style={{
              width: `${6 * scale}px`,
              height: `${13 * scale}px`,
            }}
          />
          <span
            className="rounded-full bg-current block"
            style={{
              width: `${6 * scale}px`,
              height: `${13 * scale}px`,
            }}
          />
        </div>
      );
  }
};
