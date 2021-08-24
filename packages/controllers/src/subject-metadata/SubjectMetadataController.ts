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
  subjectCacheLimit: number;
  state?: Partial<SubjectMetadataControllerState>;
};

export class SubjectMetadataController extends BaseController<
  typeof controllerName,
  SubjectMetadataControllerState
> {
  private _subjectCacheLimit: number;

  get subjectCacheLimit(): number {
    return this._subjectCacheLimit;
  }

  private subjectsEncounteredSinceStartup: Set<string>;

  private subjectHasPermissions: PermissionController['hasPermissions'];

  constructor({
    hasPermissions,
    messenger,
    subjectCacheLimit,
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
    this._subjectCacheLimit = subjectCacheLimit;
    this.subjectsEncounteredSinceStartup = new Set();
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

  /**
   * Stores domain metadata for the given origin (subject). Deletes metadata for
   * subjects without permissions in a FIFO manner, once more than
   * {@link SubjectMetadataController.subjectCacheLimit} distinct origins have
   * been added since boot.
   *
   * Metadata is never deleted for subjects with permissions, to prevent a
   * degraded user experience, since metadata cannot yet be requested on demand.
   *
   * @param subjectOrigin - The origin of the subject whose metadata to store.
   * @param metadata - The subject metadata to store.
   */
  addSubjectMetadata(
    subjectOrigin: SubjectOrigin,
    metadata: SubjectMetadata,
  ): void {
    const newMetadata = { ...metadata };
    let originToForget: string | null = null;

    // We only delete the oldest encountered subject from the cache, again to
    // ensure that the user's experience isn't degraded by missing icons etc.
    if (this.subjectsEncounteredSinceStartup.size >= this.subjectCacheLimit) {
      const cachedOrigin = this.subjectsEncounteredSinceStartup
        .values()
        .next().value;

      this.subjectsEncounteredSinceStartup.delete(cachedOrigin);
      if (this.subjectHasPermissions(cachedOrigin)) {
        originToForget = cachedOrigin;
      }
    }

    this.subjectsEncounteredSinceStartup.add(subjectOrigin);

    if (!newMetadata.extensionId && !newMetadata.host) {
      newMetadata.host = new URL(origin).host;
    }

    this.update((draftState) => {
      // Typecasts: ts(2589)
      draftState.subjectMetadata[subjectOrigin] = newMetadata as any;
      if (typeof originToForget === 'string') {
        delete draftState.subjectMetadata[originToForget];
      }
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
    hasPermissions: SubjectMetadataController['subjectHasPermissions'],
  ): void {
    const { subjectMetadata } = draftState;

    Object.keys(subjectMetadata).forEach((origin) => {
      if (!hasPermissions(origin)) {
        delete subjectMetadata[origin];
      }
    });
  }
}
