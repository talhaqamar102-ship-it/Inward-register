import type { SizeBreakdown } from './utils/requisitionLogic';

export interface GRNRecord {
  sr: number;
  grnCode?: string;
  date: string;
  pendingOrderId: string;
  maker: string;
  hallName?: string;
  stitcherName?: string;
  receivingNote?: string;
  article: string;
  color?: string;
  receivedFrom?: string;
  rcvdPairs: number;
  sizeFormat?: string;
  sizeCodes?: string[];
  sizes: SizeBreakdown;
  status: string;
  isVoided?: boolean;
  voidReason?: string;
  isDemoScenario?: boolean;
}

export interface DefectRecord {
  altId?: number;
  id: string;
  reqNumber?: string;
  orderId?: string;
  pairsCount?: number;
  rawStatus?: string;
  handoffStage?: string;
  tailorAssigned?: boolean;
  date: string;
  origin: string;
  article: string;
  po: string;
  defectClass: string;
  qty: string;
  tailor: string;
  status: 'Pending Tailor' | 'In Rework' | 'In Washing' | 'At Inward' | 'Re-Issue Requested' | 'Completed' | 'In Sorting' | 'Scrapped';
  route: string;
  actionText: string;
}

export interface CartonRecord {
  cartonNo: string;
  pairs: number;
  netWt: string;
  grossWt: string;
  dims: string;
  cbm: number;
  shippingMode: 'UNASSIGNED' | 'AIR' | 'SEA';
  dispatchedAt: string | null;
  barcodeVerified: boolean;
  sealNo: string;
  status: string;
}

export interface GrnRemainingCaps {
  sizePlanned: Record<string, number>;
  sizeRemaining: Record<string, number>;
  totalRemaining: number;
  sizeFormat: string;
  sizeCodes: string[];
}
