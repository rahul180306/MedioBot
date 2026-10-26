import React from 'react';

export const ProviderIcon: React.FC<{ type: string; className?: string }> = ({
  type,
  className = 'w-4 h-4',
}) => {
  switch (type?.toLowerCase()) {
    case 'opencode':
    case 'opencode-zen':
    case 'opencode-go':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="m18 16 4-4-4-4" />
          <path d="m6 8-4 4 4 4" />
          <path d="m14.5 4-5 16" />
        </svg>
      );

    case 'anthropic':
    case 'claude':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M13.827 4.156h3.407l5.249 15.688h-3.407l-1.045-3.216H11.23l-1.045 3.216H6.778L12.028 4.156zm3.262 9.61l-1.92-5.918-1.92 5.918h3.84z" />
        </svg>
      );

    case 'openai':
    case 'chatgpt':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.259 23.35a6.0558 6.0558 0 0 0 5.7712-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0558 6.0558 0 0 0-.746-7.0966zM13.259 21.8087a4.526 4.526 0 0 1-2.8718-1.0378l.1428-.081 4.7619-2.75a.7857.7857 0 0 0 .3929-.6809v-6.7143l2.0238 1.169a.0952.0952 0 0 1 .0476.081v5.5238a4.5238 4.5238 0 0 1-4.4972 4.4893zm-8.3582-3.568a4.5238 4.5238 0 0 1-.5714-3.0095l.1428.0833 4.7619 2.75a.7857.7857 0 0 0 .7858 0l5.8095-3.3571v2.338a.0952.0952 0 0 1-.0476.081l-4.7857 2.7643a4.5238 4.5238 0 0 1-6.0953-1.65zm-1.75-9.4143a4.5238 4.5238 0 0 1 2.3-1.9714v5.6738l5.8095 3.3571a.7857.7857 0 0 0 .7857 0l5.8096-3.3571-2.0238-1.169a.0952.0952 0 0 0-.0953 0l-4.7857 2.7619a4.5238 4.5238 0 0 1-6.2047-1.3005l-.0143-.0285zm13.8905 1.9524l-5.8095 3.3571-5.8095-3.3571 2.0238-1.169a.0952.0952 0 0 1 .0952 0l4.7857 2.7619a4.5238 4.5238 0 0 1 7.3238-2.6785v.1714l-4.7619 2.75a.7857.7857 0 0 0-.3929.6809v6.7143l2.0238-1.169a.0952.0952 0 0 0 .0476-.081V10.7714zm3.5643 6.0095l-.1428-.0833-4.7619-2.75a.7857.7857 0 0 0-.7858 0L9.2048 17.2952v-2.338a.0952.0952 0 0 1 .0476-.081l4.7857-2.7643a4.5238 4.5238 0 0 1 6.6667 4.6619zm.6428-4.2238a4.5238 4.5238 0 0 1-.5714 3.0095l-.1428-.0833-4.7619-2.75a.7857.7857 0 0 0-.7858 0L8.6238 11.2857V8.9476a.0952.0952 0 0 1 .0476-.081l4.7857-2.7643a4.5238 4.5238 0 0 1 6.1191 1.6238 4.5 4.5 0 0 1 .55 2.8095z" />
        </svg>
      );

    case 'google':
    case 'gemini':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12 0C12 6.627 17.373 12 24 12C17.373 12 12 17.373 12 24C12 17.373 6.627 12 0 12C6.627 12 12 6.627 12 0Z" />
        </svg>
      );

    case 'openrouter':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 14.93V15a1 1 0 0 0-2 0v1.93A8 8 0 0 1 4.07 13H6a1 1 0 0 0 0-2H4.07A8 8 0 0 1 11 4.07V6a1 1 0 0 0 2 0V4.07A8 8 0 0 1 19.93 11H18a1 1 0 0 0 0 2h1.93A8 8 0 0 1 13 16.93z" />
        </svg>
      );

    case 'vercel':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12 1L24 22H0L12 1Z" />
        </svg>
      );

    case 'groq':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M4 4h16v16H4V4zm3 3v10h10V7H7zm2 2h6v6H9V9z" />
        </svg>
      );

    case 'ollama':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M10 2a2 2 0 0 0-2 2v2H7a2 2 0 0 0-2 2v2c0 1.1.9 2 2 2h1v8h2v-8h2v8h2v-8h1a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-1V4a2 2 0 0 0-2-2h-2zm0 2h2v2h-2V4z" />
        </svg>
      );

    case 'mistral':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M3 3h3v18H3V3zm15 0h3v18h-3V3zM6 6h3v12H6V6zm9 0h3v12h-3V6zm-6 3h6v6H9V9z" />
        </svg>
      );

    case 'deepseek':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12 3c-4.97 0-9 4.03-9 9 0 2.12.74 4.07 1.97 5.61l-.85 2.12a.75.75 0 0 0 .96.96l2.12-.85A8.96 8.96 0 0 0 12 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm4.5 10a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z" />
        </svg>
      );

    case '302-ai':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12 2L3 7v10l9 5 9-5V7l-9-5zm0 2.2L18.8 8 12 11.8 5.2 8 12 4.2zM5 9.5l6 3.3v6.7l-6-3.3V9.5zm14 6.7l-6 3.3v-6.7l6-3.3v6.7z" />
        </svg>
      );

    case 'abacus':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12 2L2 22h4l2.5-5h7l2.5 5h4L12 2zm-2.2 12L12 8.5l2.2 5.5H9.8z" />
        </svg>
      );

    case 'nvidia':
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M12 4c-4.4 0-8 3.6-8 8s3.6 8 8 8 8-3.6 8-8-3.6-8-8-8zm0 2c3.3 0 6 2.7 6 6s-2.7 6-6 6-6-2.7-6-6 2.7-6 6-6zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />
        </svg>
      );

    case 'custom':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3z" />
        </svg>
      );

    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      );
  }
};
