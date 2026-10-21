import { invoke } from '@tauri-apps/api/core';

export interface SystemFontFace {
  family: string;
  postScriptName: string;
  weight: number;
  style: 'normal' | 'italic' | 'oblique' | string;
  monospaced: boolean;
  faceIndex: number;
}

export interface SystemFontFamily {
  name: string;
  monospaced: boolean;
  faces: SystemFontFace[];
}

export interface FontQuery {
  family: string;
  style?: string;
  weight?: number;
}

export async function listSystemFonts(): Promise<SystemFontFamily[]> {
  return invoke<SystemFontFamily[]>('fonts_list');
}

export async function lookupSystemFont(query: FontQuery): Promise<SystemFontFace> {
  return invoke<SystemFontFace>('font_lookup', {
    family: query.family,
    style: query.style,
    weight: query.weight
  });
}

export async function readSystemFont(query: FontQuery): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('font_data', {
    family: query.family,
    style: query.style,
    weight: query.weight
  });
}
