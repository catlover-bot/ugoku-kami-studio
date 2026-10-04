/** Public, browser-safe design contract. All geometry is millimetres. */
export type Direction = 'right' | 'left' | 'up' | 'down';
export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type ImageSource = { id: string; widthPx: number; heightPx: number; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' };
/** An author-chosen print treatment, never inferred or generated from missing pixels. */
export type ArtworkRepair = { mode: 'white' } | { mode: 'solid'; color: string } | { mode: 'image'; image: ImageSource };
export type ArtworkComposition = {
  source: Rect;
  fixedMask: { rect: Rect; color: string };
  background: null | { image: ImageSource; placement: Rect; clip: Rect };
  movingPaper: Rect;
};
export type LockKey = 'travelMm' | 'direction' | 'widthMm' | 'heightMm' | 'maxSheets' | 'selection' | 'paperThicknessMm' | 'clearanceMm';
export type DesignInput = {
  title: string;
  image: ImageSource;
  artworkRepair?: ArtworkRepair;
  selection: Rect; // original image pixels
  direction: Direction;
  travelMm: number;
  widthMm: number;
  heightMm: number;
  maxSheets: number;
  paperThicknessMm: number;
  clearanceMm: number;
  locks: LockKey[];
};
export type DesignPatch = Partial<Pick<DesignInput, 'title' | 'direction' | 'travelMm' | 'widthMm' | 'heightMm' | 'maxSheets' | 'paperThicknessMm' | 'clearanceMm' | 'selection'>>;
export type PartRole = 'base' | 'artwork' | 'pull-tab' | 'guide' | 'stopper' | 'connector';
export type Part = {
  id: string;
  label: string;
  role: PartRole;
  widthMm: number;
  heightMm: number;
  layer: 'front' | 'base' | 'back';
  /** Local part coordinates; marks survive paper placement/rotation. */
  cuts: Rect[];
  folds: { from: Point; to: Point }[];
  glue: { rect: Rect; label: string }[];
  /** Assembly pose at travel=0; coordinates in base space. */
  assembly: Rect;
  attachedTo: string[];
};
export type CheckResult = {
  id: string;
  status: 'pass' | 'fail' | 'unknown';
  message: string;
  suggestion?: string;
  partIds: string[];
  scope: string;
  designHash: string;
};
export type PartPlacement = { partId: string; page: number; xMm: number; yMm: number; rotated: boolean };
export type DesignDocument = {
  schemaVersion: 1 | 2;
  designId: string;
  revision: number;
  designHash: string;
  unit: 'mm';
  mechanism: 'single-pull-tab';
  input: DesignInput;
  artwork: { placement: Rect; selectionMm: Rect; mask: 'white-rectangle' | 'solid-rectangle' | 'image-rectangle' };
  motion: { direction: Direction; axis: Point; minMm: 0; maxMm: number; connector: Point; guideCenters: Point[]; slot: Rect };
  parts: Part[];
  layout: { pageWidthMm: 210; pageHeightMm: 297; marginMm: 10; sheets: number; placements: PartPlacement[]; unplacedPartIds: string[]; algorithm: 'deterministic-shelf-v1' };
  checks: CheckResult[];
  assumptions: string[];
  physicalValidation: 'unverified';
};
export type AssemblyStep = {
  number: number; title: string; description: string; partIds: string[];
  diagram: 'cut' | 'fold' | 'guide' | 'connect' | 'stop' | 'test';
  view: 'front' | 'back' | 'both' | 'separate';
  beforePartIds: string[];
  addedPartIds: string[];
  afterPartIds: string[];
  glueInstructions: string[];
  doNotGlue: string[];
};

export type KitSummary = {
  status: 'prototype' | 'blocked';
  statusLabel: string;
  patternSheets: number;
  partCount: number;
  directionLabel: string;
  travelMm: number;
  handleExposureMm: { start: number; end: number };
  checks: CheckResult[];
  physicalTestItems: string[];
};
