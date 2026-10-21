import type { ITheme } from '@xterm/xterm';

export type TerminalColorSchemeVariant = 'dark' | 'light';

export interface TerminalColorScheme {
  id: string;
  name: string;
  description: string;
  variant: TerminalColorSchemeVariant;
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  colors: Pick<
    ITheme,
    | 'black'
    | 'red'
    | 'green'
    | 'yellow'
    | 'blue'
    | 'magenta'
    | 'cyan'
    | 'white'
    | 'brightBlack'
    | 'brightRed'
    | 'brightGreen'
    | 'brightYellow'
    | 'brightBlue'
    | 'brightMagenta'
    | 'brightCyan'
    | 'brightWhite'
  >;
}

interface RawScheme {
  id: string;
  name: string;
  description: string;
  variant: TerminalColorSchemeVariant;
  background: string;
  foreground: string;
  palette: [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string
  ];
}

const rgb = (r: number, g: number, b: number): string => `rgb(${r}, ${g}, ${b})`;

function withAlpha(color: string, alpha: number): string {
  const match = color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (!match) {
    return color;
  }
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${alpha})`;
}

function buildScheme(raw: RawScheme): TerminalColorScheme {
  const [
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite
  ] = raw.palette;

  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    variant: raw.variant,
    background: raw.background,
    foreground: raw.foreground,
    cursor: raw.foreground,
    selectionBackground: withAlpha(raw.foreground, 0.28),
    colors: {
      black,
      red,
      green,
      yellow,
      blue,
      magenta,
      cyan,
      white,
      brightBlack,
      brightRed,
      brightGreen,
      brightYellow,
      brightBlue,
      brightMagenta,
      brightCyan,
      brightWhite
    }
  };
}

const RAW_SCHEMES: RawScheme[] = [
  {
    id: 'white-on-black',
    name: 'White on Black',
    description: 'QTerminal 经典白字黑底',
    variant: 'dark',
    background: rgb(0, 0, 0),
    foreground: rgb(255, 255, 255),
    palette: [
      rgb(0, 0, 0),
      rgb(178, 24, 24),
      rgb(24, 178, 24),
      rgb(178, 104, 24),
      rgb(24, 24, 178),
      rgb(178, 24, 178),
      rgb(24, 178, 178),
      rgb(178, 178, 178),
      rgb(104, 104, 104),
      rgb(255, 84, 84),
      rgb(84, 255, 84),
      rgb(255, 255, 84),
      rgb(84, 84, 255),
      rgb(255, 84, 255),
      rgb(84, 255, 255),
      rgb(255, 255, 255)
    ]
  },
  {
    id: 'black-on-light-yellow',
    name: 'Black on Light Yellow',
    description: 'QTerminal 黑字浅黄底',
    variant: 'light',
    background: rgb(255, 255, 221),
    foreground: rgb(0, 0, 0),
    palette: [
      rgb(0, 0, 0),
      rgb(178, 24, 24),
      rgb(24, 178, 24),
      rgb(178, 104, 24),
      rgb(24, 24, 178),
      rgb(178, 24, 178),
      rgb(24, 178, 178),
      rgb(178, 178, 178),
      rgb(104, 104, 104),
      rgb(255, 84, 84),
      rgb(84, 255, 84),
      rgb(255, 255, 84),
      rgb(84, 84, 255),
      rgb(255, 84, 255),
      rgb(84, 255, 255),
      rgb(255, 255, 255)
    ]
  },
  {
    id: 'black-on-random-light',
    name: 'Black on Random Light',
    description: 'QTerminal 黑字浅色底',
    variant: 'light',
    background: rgb(247, 247, 214),
    foreground: rgb(0, 0, 0),
    palette: [
      rgb(0, 0, 0),
      rgb(178, 24, 24),
      rgb(24, 178, 24),
      rgb(178, 104, 24),
      rgb(24, 24, 178),
      rgb(178, 24, 178),
      rgb(24, 178, 178),
      rgb(178, 178, 178),
      rgb(104, 104, 104),
      rgb(255, 84, 84),
      rgb(84, 255, 84),
      rgb(255, 255, 84),
      rgb(84, 84, 255),
      rgb(255, 84, 255),
      rgb(84, 255, 255),
      rgb(255, 255, 255)
    ]
  },
  {
    id: 'black-on-white',
    name: 'Black on White',
    description: 'QTerminal 黑字白底',
    variant: 'light',
    background: rgb(255, 255, 255),
    foreground: rgb(0, 0, 0),
    palette: [
      rgb(0, 0, 0),
      rgb(178, 24, 24),
      rgb(24, 178, 24),
      rgb(178, 104, 24),
      rgb(24, 24, 178),
      rgb(178, 24, 178),
      rgb(24, 178, 178),
      rgb(178, 178, 178),
      rgb(104, 104, 104),
      rgb(255, 84, 84),
      rgb(84, 255, 84),
      rgb(255, 255, 84),
      rgb(84, 84, 255),
      rgb(255, 84, 255),
      rgb(84, 255, 255),
      rgb(255, 255, 255)
    ]
  },
  {
    id: 'breeze-modified',
    name: 'Breeze Modified',
    description: 'QTerminal Breeze 变体',
    variant: 'dark',
    background: rgb(49, 54, 59),
    foreground: rgb(239, 240, 241),
    palette: [
      rgb(7, 54, 66),
      rgb(237, 21, 21),
      rgb(17, 209, 22),
      rgb(246, 116, 0),
      rgb(29, 153, 243),
      rgb(155, 89, 182),
      rgb(26, 188, 156),
      rgb(239, 240, 241),
      rgb(255, 85, 0),
      rgb(192, 57, 43),
      rgb(28, 220, 154),
      rgb(253, 188, 75),
      rgb(61, 174, 233),
      rgb(142, 68, 173),
      rgb(22, 160, 133),
      rgb(252, 252, 252)
    ]
  },
  {
    id: 'dark-pastels',
    name: 'Dark Pastels',
    description: 'QTerminal 柔和暗色',
    variant: 'dark',
    background: rgb(44, 44, 44),
    foreground: rgb(220, 220, 204),
    palette: [
      rgb(63, 63, 63),
      rgb(112, 80, 80),
      rgb(96, 180, 138),
      rgb(223, 175, 143),
      rgb(154, 184, 215),
      rgb(220, 140, 195),
      rgb(140, 208, 211),
      rgb(220, 220, 204),
      rgb(112, 144, 128),
      rgb(220, 163, 163),
      rgb(114, 213, 163),
      rgb(240, 223, 175),
      rgb(148, 191, 243),
      rgb(236, 147, 211),
      rgb(147, 224, 227),
      rgb(255, 255, 255)
    ]
  },
  {
    id: 'falcon',
    name: 'Falcon',
    description: 'QTerminal Falcon 深青配色',
    variant: 'dark',
    background: rgb(34, 51, 51),
    foreground: rgb(194, 194, 194),
    palette: [
      rgb(149, 149, 149),
      rgb(255, 101, 101),
      rgb(132, 194, 78),
      rgb(207, 191, 41),
      rgb(110, 215, 255),
      rgb(252, 175, 62),
      rgb(183, 176, 232),
      rgb(255, 255, 255),
      rgb(149, 149, 149),
      rgb(255, 101, 101),
      rgb(132, 194, 78),
      rgb(207, 191, 41),
      rgb(110, 215, 255),
      rgb(252, 175, 62),
      rgb(183, 176, 232),
      rgb(255, 255, 255)
    ]
  },
  {
    id: 'green-on-black',
    name: 'Green on Black',
    description: 'QTerminal 绿字黑底',
    variant: 'dark',
    background: rgb(0, 0, 0),
    foreground: rgb(24, 240, 24),
    palette: [
      rgb(0, 0, 0),
      rgb(250, 75, 75),
      rgb(24, 178, 24),
      rgb(178, 104, 24),
      rgb(92, 167, 251),
      rgb(225, 30, 225),
      rgb(24, 178, 178),
      rgb(178, 178, 178),
      rgb(104, 104, 104),
      rgb(255, 84, 84),
      rgb(84, 255, 84),
      rgb(255, 255, 84),
      rgb(84, 84, 255),
      rgb(255, 84, 255),
      rgb(84, 255, 255),
      rgb(255, 255, 255)
    ]
  },
  {
    id: 'linux',
    name: 'Linux Colors',
    description: 'QTerminal Linux 标准色',
    variant: 'dark',
    background: rgb(0, 0, 0),
    foreground: rgb(178, 178, 178),
    palette: [
      rgb(0, 0, 0),
      rgb(178, 24, 24),
      rgb(24, 178, 24),
      rgb(178, 104, 24),
      rgb(24, 24, 178),
      rgb(178, 24, 178),
      rgb(24, 178, 178),
      rgb(178, 178, 178),
      rgb(104, 104, 104),
      rgb(255, 84, 84),
      rgb(84, 255, 84),
      rgb(255, 255, 84),
      rgb(84, 84, 255),
      rgb(255, 84, 255),
      rgb(84, 255, 255),
      rgb(255, 255, 255)
    ]
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'QTerminal Nord 极地色',
    variant: 'dark',
    background: rgb(46, 52, 64),
    foreground: rgb(216, 222, 233),
    palette: [
      rgb(59, 66, 82),
      rgb(191, 97, 106),
      rgb(163, 190, 140),
      rgb(235, 203, 139),
      rgb(129, 161, 193),
      rgb(180, 142, 173),
      rgb(136, 192, 208),
      rgb(229, 233, 240),
      rgb(76, 86, 106),
      rgb(191, 97, 106),
      rgb(163, 190, 140),
      rgb(235, 203, 139),
      rgb(129, 161, 193),
      rgb(180, 142, 173),
      rgb(143, 188, 187),
      rgb(236, 239, 244)
    ]
  },
  {
    id: 'solarized',
    name: 'Solarized',
    description: 'QTerminal Solarized 暗色',
    variant: 'dark',
    background: rgb(0, 43, 54),
    foreground: rgb(131, 148, 150),
    palette: [
      rgb(7, 54, 66),
      rgb(220, 50, 47),
      rgb(133, 153, 0),
      rgb(181, 137, 0),
      rgb(38, 139, 210),
      rgb(211, 54, 130),
      rgb(42, 161, 152),
      rgb(238, 232, 213),
      rgb(0, 43, 54),
      rgb(203, 75, 22),
      rgb(88, 110, 117),
      rgb(101, 123, 131),
      rgb(131, 148, 150),
      rgb(108, 113, 196),
      rgb(147, 161, 161),
      rgb(253, 246, 227)
    ]
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    description: 'QTerminal Solarized 亮色',
    variant: 'light',
    background: rgb(253, 246, 227),
    foreground: rgb(101, 123, 131),
    palette: [
      rgb(7, 54, 66),
      rgb(220, 50, 47),
      rgb(133, 153, 0),
      rgb(181, 137, 0),
      rgb(38, 139, 210),
      rgb(211, 54, 130),
      rgb(42, 161, 152),
      rgb(238, 232, 213),
      rgb(0, 43, 54),
      rgb(203, 75, 22),
      rgb(88, 110, 117),
      rgb(101, 123, 131),
      rgb(131, 148, 150),
      rgb(108, 113, 196),
      rgb(147, 161, 161),
      rgb(253, 246, 227)
    ]
  },
  {
    id: 'tango',
    name: 'Tango',
    description: 'QTerminal Tango 调色板',
    variant: 'dark',
    background: rgb(0, 0, 0),
    foreground: rgb(255, 255, 255),
    palette: [
      rgb(0, 0, 0),
      rgb(204, 0, 0),
      rgb(78, 154, 6),
      rgb(196, 160, 0),
      rgb(52, 101, 164),
      rgb(117, 80, 123),
      rgb(6, 152, 154),
      rgb(211, 215, 207),
      rgb(85, 87, 83),
      rgb(239, 41, 41),
      rgb(138, 226, 52),
      rgb(252, 233, 79),
      rgb(114, 159, 207),
      rgb(173, 127, 168),
      rgb(52, 226, 226),
      rgb(238, 238, 236)
    ]
  },
  {
    id: 'ubuntu',
    name: 'Ubuntu',
    description: 'QTerminal Ubuntu 紫棕底',
    variant: 'dark',
    background: rgb(48, 10, 36),
    foreground: rgb(238, 238, 236),
    palette: [
      rgb(46, 52, 54),
      rgb(204, 0, 0),
      rgb(78, 154, 6),
      rgb(196, 160, 0),
      rgb(52, 101, 164),
      rgb(117, 80, 123),
      rgb(6, 152, 154),
      rgb(211, 215, 207),
      rgb(85, 87, 83),
      rgb(239, 41, 41),
      rgb(138, 226, 52),
      rgb(252, 233, 79),
      rgb(114, 159, 207),
      rgb(173, 127, 168),
      rgb(52, 226, 226),
      rgb(238, 238, 236)
    ]
  }
];

export const TERMINAL_COLOR_SCHEMES = RAW_SCHEMES.map(buildScheme);
export const TERMINAL_COLOR_SCHEME_IDS = new Set(TERMINAL_COLOR_SCHEMES.map((scheme) => scheme.id));

export const DEFAULT_TERMINAL_COLOR_SCHEME = 'theme';

export function normalizeTerminalColorSchemeId(value: unknown): string {
  return value === DEFAULT_TERMINAL_COLOR_SCHEME || TERMINAL_COLOR_SCHEME_IDS.has(String(value))
    ? String(value)
    : DEFAULT_TERMINAL_COLOR_SCHEME;
}

export function getTerminalColorScheme(id: string): TerminalColorScheme | undefined {
  return TERMINAL_COLOR_SCHEMES.find((scheme) => scheme.id === id);
}
