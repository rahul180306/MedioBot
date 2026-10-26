export interface MediobotPresentation {
  readonly id: string;
  readonly displayName: string;
  readonly specialization: string;
  readonly avatar: string;
  readonly eye: string;
  readonly delay: string;
  readonly text: string;
  readonly darkText: string;
  readonly lightText: string;
  readonly border: string;
  readonly badge: string;
  readonly darkBadge: string;
  readonly lightBadge: string;
}

const PRESENTATION_BY_ID: Readonly<Record<string, MediobotPresentation>> = {
  maestro: {
    id: 'maestro',
    displayName: 'Maestro',
    specialization: 'Team orchestration',
    avatar: 'bg-[#f4f4f5]',
    eye: 'bg-black',
    delay: '0.2s',
    text: 'text-[#f4f4f5]',
    darkText: 'text-[#f4f4f5]',
    lightText: 'text-[#18181b]',
    border: 'border-white/20 hover:border-white/50',
    badge: 'bg-white/10 text-neutral-200',
    darkBadge: 'bg-white/10 text-neutral-200 border border-white/10',
    lightBadge: 'bg-zinc-100 text-zinc-800 border border-zinc-300/80 font-semibold',
  },
  cody: {
    id: 'cody',
    displayName: 'Cody',
    specialization: 'Software engineering',
    avatar: 'bg-[#fef08a]',
    eye: 'bg-black',
    delay: '0s',
    text: 'text-[#fde047]',
    darkText: 'text-[#fde047]',
    lightText: 'text-[#854d0e]',
    border: 'border-[#fef08a]/30 hover:border-[#fef08a]/60',
    badge: 'bg-[#fef08a]/10 text-[#fef08a]',
    darkBadge: 'bg-[#fef08a]/10 text-[#fef08a] border border-[#fef08a]/20',
    lightBadge: 'bg-amber-100/90 text-amber-900 border border-amber-300/80 font-semibold',
  },
  vision: {
    id: 'vision',
    displayName: 'Vision',
    specialization: 'Browser and visual work',
    avatar: 'bg-[#bae6fd]',
    eye: 'bg-black',
    delay: '0.8s',
    text: 'text-[#38bdf8]',
    darkText: 'text-[#38bdf8]',
    lightText: 'text-[#0369a1]',
    border: 'border-[#bae6fd]/30 hover:border-[#bae6fd]/60',
    badge: 'bg-[#bae6fd]/10 text-[#bae6fd]',
    darkBadge: 'bg-[#bae6fd]/10 text-[#bae6fd] border border-[#bae6fd]/20',
    lightBadge: 'bg-sky-100/90 text-sky-900 border border-sky-300/80 font-semibold',
  },
  doc: {
    id: 'doc',
    displayName: 'Doc',
    specialization: 'Documentation intelligence',
    avatar: 'bg-[#4b4a56]',
    eye: 'bg-white',
    delay: '1.6s',
    text: 'text-[#cbd5e1]',
    darkText: 'text-[#cbd5e1]',
    lightText: 'text-[#334155]',
    border: 'border-[#52525b]/40 hover:border-[#71717a]/60',
    badge: 'bg-[#52525b]/20 text-[#d4d4d8]',
    darkBadge: 'bg-[#52525b]/20 text-[#d4d4d8] border border-[#71717a]/30',
    lightBadge: 'bg-slate-100/90 text-slate-800 border border-slate-300/80 font-semibold',
  },
  research: {
    id: 'research',
    displayName: 'Research',
    specialization: 'Web research',
    avatar: 'bg-[#fed7aa]',
    eye: 'bg-black',
    delay: '2.4s',
    text: 'text-[#fb923c]',
    darkText: 'text-[#fb923c]',
    lightText: 'text-[#c2410c]',
    border: 'border-[#fed7aa]/30 hover:border-[#fed7aa]/60',
    badge: 'bg-[#fed7aa]/10 text-[#fed7aa]',
    darkBadge: 'bg-[#fed7aa]/10 text-[#fed7aa] border border-[#fed7aa]/20',
    lightBadge: 'bg-orange-100/90 text-orange-950 border border-orange-300/80 font-semibold',
  },
  tester: {
    id: 'tester',
    displayName: 'Tester',
    specialization: 'Independent verification',
    avatar: 'bg-[#ddd6fe]',
    eye: 'bg-[#1e1b4b]',
    delay: '1.2s',
    text: 'text-[#c084fc]',
    darkText: 'text-[#c084fc]',
    lightText: 'text-[#6b21a8]',
    border: 'border-[#ddd6fe]/30 hover:border-[#ddd6fe]/60',
    badge: 'bg-[#ddd6fe]/10 text-[#ddd6fe]',
    darkBadge: 'bg-[#ddd6fe]/10 text-[#ddd6fe] border border-[#ddd6fe]/20',
    lightBadge: 'bg-purple-100/90 text-purple-950 border border-purple-300/80 font-semibold',
  },
  deployer: {
    id: 'deployer',
    displayName: 'Deployer',
    specialization: 'Deployment',
    avatar: 'bg-[#a7f3d0]',
    eye: 'bg-[#064e3b]',
    delay: '2s',
    text: 'text-[#34d399]',
    darkText: 'text-[#34d399]',
    lightText: 'text-[#047857]',
    border: 'border-[#a7f3d0]/30 hover:border-[#a7f3d0]/60',
    badge: 'bg-[#a7f3d0]/10 text-[#a7f3d0]',
    darkBadge: 'bg-[#a7f3d0]/10 text-[#a7f3d0] border border-[#a7f3d0]/20',
    lightBadge: 'bg-emerald-100/90 text-emerald-950 border border-emerald-300/80 font-semibold',
  },
};

export const getMediobotPresentation = (id?: string, name?: string, specialization?: string): MediobotPresentation => {
  const safeId = (id || name || 'maestro').toLowerCase();
  const known = PRESENTATION_BY_ID[safeId];
  if (known) return known;
  const neutral = PRESENTATION_BY_ID.maestro;
  return { ...neutral, id: id || 'maestro', displayName: name ?? id ?? 'Maestro', specialization: specialization ?? 'Specialist Mediobot' };
};

export interface MediobotChatBarTheme {
  background: string;
  color: string;
  menuBackground: string;
  borderColor: string;
  sparkColor: string;
  hoverColor: string;
  glowColor: string;
  mutedColor: string;
  shadow: string;
}

export const getMediobotChatBarTheme = (
  id?: string,
  isLight: boolean = false
): MediobotChatBarTheme => {
  const safeId = (id || 'maestro').toLowerCase();

  switch (safeId) {
    case 'cody':
      return isLight
        ? {
            background: '#fefce8',
            color: '#451a03',
            menuBackground: '#fffdf0',
            borderColor: 'rgba(202, 138, 4, 0.35)',
            sparkColor: '#ca8a04',
            hoverColor: '#fef08a',
            glowColor: '#fde047',
            mutedColor: '#854d0e',
            shadow: '0 10px 30px -4px rgba(202, 138, 4, 0.16), 0 2px 8px -2px rgba(202, 138, 4, 0.08)',
          }
        : {
            background: '#1f1c12',
            color: '#fef9c3',
            menuBackground: '#272216',
            borderColor: 'rgba(254, 240, 138, 0.32)',
            sparkColor: '#fde047',
            hoverColor: '#2e2819',
            glowColor: '#38301c',
            mutedColor: '#facc15',
            shadow: '0 14px 38px rgba(0, 0, 0, 0.45), 0 0 26px -3px rgba(254, 240, 138, 0.16)',
          };

    case 'vision':
      return isLight
        ? {
            background: '#f0f9ff',
            color: '#082f49',
            menuBackground: '#f8fcff',
            borderColor: 'rgba(2, 132, 199, 0.32)',
            sparkColor: '#0284c7',
            hoverColor: '#e0f2fe',
            glowColor: '#bae6fd',
            mutedColor: '#0369a1',
            shadow: '0 10px 30px -4px rgba(2, 132, 199, 0.16), 0 2px 8px -2px rgba(2, 132, 199, 0.08)',
          }
        : {
            background: '#111a24',
            color: '#f0f9ff',
            menuBackground: '#162330',
            borderColor: 'rgba(186, 230, 253, 0.32)',
            sparkColor: '#38bdf8',
            hoverColor: '#1a2c3d',
            glowColor: '#22394e',
            mutedColor: '#7dd3fc',
            shadow: '0 14px 38px rgba(0, 0, 0, 0.45), 0 0 26px -3px rgba(56, 189, 248, 0.18)',
          };

    case 'doc':
      return isLight
        ? {
            background: '#f8fafc',
            color: '#0f172a',
            menuBackground: '#ffffff',
            borderColor: 'rgba(100, 116, 139, 0.32)',
            sparkColor: '#475569',
            hoverColor: '#e2e8f0',
            glowColor: '#cbd5e1',
            mutedColor: '#475569',
            shadow: '0 10px 30px -4px rgba(71, 85, 105, 0.14), 0 2px 8px -2px rgba(71, 85, 105, 0.06)',
          }
        : {
            background: '#1a1921',
            color: '#f1f5f9',
            menuBackground: '#22212b',
            borderColor: 'rgba(203, 213, 225, 0.28)',
            sparkColor: '#94a3b8',
            hoverColor: '#272633',
            glowColor: '#302f3e',
            mutedColor: '#94a3b8',
            shadow: '0 14px 38px rgba(0, 0, 0, 0.45), 0 0 26px -3px rgba(148, 163, 184, 0.14)',
          };

    case 'research':
      return isLight
        ? {
            background: '#fff7ed',
            color: '#431407',
            menuBackground: '#fffaf5',
            borderColor: 'rgba(234, 88, 12, 0.32)',
            sparkColor: '#ea580c',
            hoverColor: '#ffedd5',
            glowColor: '#fed7aa',
            mutedColor: '#c2410c',
            shadow: '0 10px 30px -4px rgba(234, 88, 12, 0.16), 0 2px 8px -2px rgba(234, 88, 12, 0.08)',
          }
        : {
            background: '#201712',
            color: '#fff7ed',
            menuBackground: '#291e17',
            borderColor: 'rgba(254, 215, 170, 0.32)',
            sparkColor: '#fb923c',
            hoverColor: '#34261d',
            glowColor: '#3f2d22',
            mutedColor: '#fdba74',
            shadow: '0 14px 38px rgba(0, 0, 0, 0.45), 0 0 26px -3px rgba(251, 146, 60, 0.18)',
          };

    case 'tester':
      return isLight
        ? {
            background: '#faf5ff',
            color: '#2e1065',
            menuBackground: '#fdfaff',
            borderColor: 'rgba(147, 51, 234, 0.32)',
            sparkColor: '#9333ea',
            hoverColor: '#f3e8ff',
            glowColor: '#ddd6fe',
            mutedColor: '#7e22ce',
            shadow: '0 10px 30px -4px rgba(147, 51, 234, 0.16), 0 2px 8px -2px rgba(147, 51, 234, 0.08)',
          }
        : {
            background: '#191424',
            color: '#faf5ff',
            menuBackground: '#221c32',
            borderColor: 'rgba(221, 214, 254, 0.32)',
            sparkColor: '#c084fc',
            hoverColor: '#2a233e',
            glowColor: '#342b4d',
            mutedColor: '#d8b4fe',
            shadow: '0 14px 38px rgba(0, 0, 0, 0.45), 0 0 26px -3px rgba(192, 132, 252, 0.18)',
          };

    case 'deployer':
      return isLight
        ? {
            background: '#ecfdf5',
            color: '#022c22',
            menuBackground: '#f4fef9',
            borderColor: 'rgba(5, 150, 105, 0.32)',
            sparkColor: '#059669',
            hoverColor: '#d1fae5',
            glowColor: '#a7f3d0',
            mutedColor: '#047857',
            shadow: '0 10px 30px -4px rgba(5, 150, 105, 0.16), 0 2px 8px -2px rgba(5, 150, 105, 0.08)',
          }
        : {
            background: '#101e17',
            color: '#ecfdf5',
            menuBackground: '#16281f',
            borderColor: 'rgba(167, 243, 208, 0.32)',
            sparkColor: '#34d399',
            hoverColor: '#1a3327',
            glowColor: '#214232',
            mutedColor: '#6ee7b7',
            shadow: '0 14px 38px rgba(0, 0, 0, 0.45), 0 0 26px -3px rgba(52, 211, 153, 0.18)',
          };

    case 'maestro':
    default:
      return isLight
        ? {
            background: '#ffffff',
            color: '#09090b',
            menuBackground: '#ffffff',
            borderColor: '#d4d4d8',
            sparkColor: '#18181b',
            hoverColor: '#f4f4f6',
            glowColor: '#e4e4e7',
            mutedColor: '#71717a',
            shadow: '0 10px 30px -4px rgba(0, 0, 0, 0.08), 0 2px 8px -2px rgba(0, 0, 0, 0.04)',
          }
        : {
            background: '#1c1c22',
            color: '#f4f4f5',
            menuBackground: '#23232a',
            borderColor: 'rgba(244, 244, 245, 0.20)',
            sparkColor: '#f4f4f5',
            hoverColor: '#282832',
            glowColor: '#2f2f3b',
            mutedColor: '#a1a1aa',
            shadow: '0 14px 38px rgba(0, 0, 0, 0.45), 0 0 24px -4px rgba(244, 244, 245, 0.08)',
          };
  }
};

export const getDefaultChatBarTheme = (isLight: boolean = false): MediobotChatBarTheme => {
  return isLight
    ? {
        background: '#ffffff',
        color: '#111827',
        menuBackground: '#ffffff',
        borderColor: '#e2e4e8',
        sparkColor: '#7c3aed',
        hoverColor: '#f4f4f7',
        glowColor: '#e4e4e7',
        mutedColor: '#71717a',
        shadow: '0 10px 30px -4px rgba(0, 0, 0, 0.08), 0 2px 8px -2px rgba(0, 0, 0, 0.04)',
      }
    : {
        background: '#1e1e24',
        color: '#f5f5f5',
        menuBackground: '#25252b',
        borderColor: 'rgba(255, 255, 255, 0.09)',
        sparkColor: '#b39dff',
        hoverColor: '#32313a',
        glowColor: '#32313a',
        mutedColor: 'rgba(245, 245, 245, 0.55)',
        shadow: '0 12px 36px rgba(0, 0, 0, 0.35)',
      };
};
