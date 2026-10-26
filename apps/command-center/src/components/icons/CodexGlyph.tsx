import React from 'react';

interface CodexGlyphProps {
  className?: string;
  isLight?: boolean;
  bgColor?: string;
  eyeColor?: string;
}

export const CodexGlyph: React.FC<CodexGlyphProps> = ({
  className = 'w-16 h-16',
  isLight = false,
  bgColor,
  eyeColor,
}) => {
  const bgFill = bgColor || (isLight ? '#18181b' : '#f4f4f5');
  const eyeFill = eyeColor || (isLight ? '#ffffff' : '#000000');
  const ringStroke = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.18)';

  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`select-none transition-transform duration-300 hover:scale-105 drop-shadow-xl ${className}`}
      data-testid="mediobot-circle-eye-svg"
    >
      <defs>
        <filter id="emblem-shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="4" stdDeviation="5" floodOpacity={isLight ? '0.1' : '0.35'} />
        </filter>
      </defs>
      {/* Outer Circle Emblem Container */}
      <circle
        cx="32"
        cy="32"
        r="30"
        fill={bgFill}
        stroke={ringStroke}
        strokeWidth="1.2"
        filter="url(#emblem-shadow)"
      />
      {/* Left Vertical Blinking Eye */}
      <rect
        x="22.5"
        y="21"
        width="6.5"
        height="22"
        rx="3.25"
        fill={eyeFill}
        className="animate-eye-blink"
        style={{ transformOrigin: '25.75px 32px' }}
      />
      {/* Right Vertical Blinking Eye */}
      <rect
        x="35"
        y="21"
        width="6.5"
        height="22"
        rx="3.25"
        fill={eyeFill}
        className="animate-eye-blink"
        style={{ transformOrigin: '38.25px 32px' }}
      />
    </svg>
  );
};
