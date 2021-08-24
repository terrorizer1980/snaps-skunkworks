import {
  BaseControllerV2 as BaseController,
  RestrictedControllerMessenger,
} from '@metamask/controllers';
import type { Patch } from 'immer';
import { Json } from 'json-rpc-engine';

import type {
  PermissionController,
  PermissionsSubjectMetadata,
} from '../permissions';

const controllerName = 'SubjectMetadataController';

type SubjectOrigin = string;

export type SubjectMetadata = PermissionsSubjectMetadata & {
  [key: string]: Json;
  name: string;
  // TODO:TS4.4 make optional
  iconUrl: string | null;
  host: string | null;
  extensionId: string | null;
};

export type SubjectMetadataControllerState = {
  subjectMetadata: Record<SubjectOrigin, SubjectMetadata>;
};

const stateMetadata = {
  subjectMetadata: { persist: true, anonymous: true },
};

const defaultState: SubjectMetadataControllerState = {
  subjectMetadata: {},
};

export type GetSubjectMetadataState = {
  type: `${typeof controllerName}:getState`;
  handler: () => SubjectMetadataControllerState;
};

export type ClearSubjectMetadataState = {
  type: `${typeof controllerName}:clearState`;
  handler: () => void;
};

export type TrimSubjectMetadataState = {
  type: `${typeof controllerName}:trimSubjectMetadataState`;
  handler: () => void;
};

export type SubjectMetadataControllerActions =
  | GetSubjectMetadataState
  | ClearSubjectMetadataState
  | TrimSubjectMetadataState;

export type SubjectMetadataStateChange = {
  type: `${typeof controllerName}:stateChange`;
  payload: [SubjectMetadataControllerState, Patch[]];
};

export type SubjectMetadataControllerEvents = SubjectMetadataStateChange;

export type SubjectMetadataControllerMessenger = RestrictedControllerMessenger<
  typeof controllerName,
  SubjectMetadataControllerActions,
  SubjectMetadataControllerEvents,
  never,
  never
>;

type SubjectMetadataControllerOptions = {
  hasPermissions: PermissionController['hasPermissions'];
  messenger: SubjectMetadataControllerMessenger;
  metadataCacheSize: number;
  state?: Partial<SubjectMetadataControllerState>;
};

export class SubjectMetadataController extends BaseController<
  typeof controllerName,
  SubjectMetadataControllerState
> {
  private _metadataCacheSize: number;

  get metadataCacheSize(): number {
    return this._metadataCacheSize;
  }

  private pendingMetadataCache: Set<string>;

  private subjectHasPermissions: PermissionController['hasPermissions'];

  constructor({
    hasPermissions,
    messenger,
    metadataCacheSize,
    state = {},
  }: SubjectMetadataControllerOptions) {
    if (state.subjectMetadata) {
      SubjectMetadataController.trimMetadataState(
        state as SubjectMetadataControllerState,
        hasPermissions,
      );
    }

    super({
      name: controllerName,
      metadata: stateMetadata,
      messenger,
      state: { ...defaultState, ...state },
    });

    this.subjectHasPermissions = hasPermissions;
    this._metadataCacheSize = metadataCacheSize;
    this.pendingMetadataCache = new Set();
    this.registerMessageHandlers();
  }

  private registerMessageHandlers(): void {
    this.messagingSystem.registerActionHandler(
      `${controllerName}:clearState`,
      () => this.clearState(),
    );

    this.messagingSystem.registerActionHandler(
      `${controllerName}:trimSubjectMetadataState`,
      () => this.trimMetadataState(),
    );
  }

  clearState(): void {
    this.update((_draftState) => {
      return { ...defaultState };
    });
  }

  addSubjectMetadata(
    subjectOrigin: SubjectOrigin,
    metadata: SubjectMetadata,
  ): void {
    const subjectsToTrim: SubjectOrigin[] = [];

    if (this.pendingMetadataCache.size >= this._metadataCacheSize) {
      this.pendingMetadataCache.forEach((cachedOrigin) => {
        if (!this.subjectHasPermissions(cachedOrigin)) {
          subjectsToTrim.push(cachedOrigin);
        }

        this.pendingMetadataCache.delete(cachedOrigin);
      });
    }

    this.pendingMetadataCache.add(subjectOrigin);
    this.update((draftState) => {
      // Typecasts: ts(2589)
      draftState.subjectMetadata[subjectOrigin] = metadata as any;
      SubjectMetadataController.trimMetadataState(
        draftState as any,
        subjectsToTrim,
      );
    });
  }

  private trimMetadataState(): void {
    this.update((draftState) => {
      SubjectMetadataController.trimMetadataState(
        draftState as any,
        this.subjectHasPermissions,
      );
    });
  }

  private static trimMetadataState(
    draftState: SubjectMetadataControllerState,
    subjectsToTrimOrHasPermissions:
      | SubjectMetadataController['subjectHasPermissions']
      | SubjectOrigin[],
  ): void {
    const { subjectMetadata } = draftState;

    if (typeof subjectsToTrimOrHasPermissions === 'function') {
      Object.keys(subjectMetadata).forEach((origin) => {
        if (!subjectsToTrimOrHasPermissions(origin)) {
          delete subjectMetadata[origin];
        }
      });
    } else {
      subjectsToTrimOrHasPermissions.forEach(
        (origin) => delete subjectMetadata[origin],
      );
    }
  }
}
