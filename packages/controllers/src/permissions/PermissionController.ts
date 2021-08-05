import type { Patch } from 'immer';
import deepEqual from 'fast-deep-equal';
import {
  BaseControllerV2 as BaseController,
  RestrictedControllerMessenger,
} from '@metamask/controllers';
import {
  Json,
  JsonRpcEngineEndCallback,
  JsonRpcEngineNextCallback,
  JsonRpcMiddleware,
  JsonRpcRequest,
  PendingJsonRpcResponse,
} from 'json-rpc-engine';

import { CaveatSpecifications } from './caveat-processing';
import {
  OriginString,
  Permission,
  MethodName,
  RequestedPermissions,
} from './Permission';
import {
  PermissionDoesNotExistError,
  methodNotFound,
  UnrecognizedSubjectError,
  PermissionHasNoCaveatsError,
  CaveatDoesNotExistError,
  CaveatTypeDoesNotExistError,
  InvalidCaveatJsonError,
  PermissionTargetDoesNotExistError,
  CaveatMissingValueError,
  InvalidCaveatFieldsError,
  InvalidSubjectIdentifierError,
} from './errors';
import { Caveat } from './Caveat';

export interface SubjectMetadata {
  origin: OriginString;
}

const controllerName = 'PermissionController';

export interface PermissionsSubjectEntry extends SubjectMetadata {
  permissions: Record<MethodName, Permission>;
}

export type PermissionControllerSubjects = Record<
  OriginString,
  PermissionsSubjectEntry
>;

// TODO: TypeScript doesn't understand that a given subject may not exist.
export type PermissionControllerState = {
  subjects: PermissionControllerSubjects;
};

const stateMetadata = {
  subjects: { persist: true, anonymous: true },
};

const defaultState: PermissionControllerState = {
  subjects: {},
};

export type GetPermissionsState = {
  type: `${typeof controllerName}:getState`;
  handler: () => PermissionControllerState;
};

export type GetSubjects = {
  type: `${typeof controllerName}:getSubjects`;
  handler: () => (keyof PermissionControllerSubjects)[];
};

export type ClearPermissions = {
  type: `${typeof controllerName}:clearPermissions`;
  handler: () => void;
};

export type PermissionsStateChange = {
  type: `${typeof controllerName}:stateChange`;
  payload: [PermissionControllerState, Patch[]];
};

export type PermissionControllerActions =
  | GetPermissionsState
  | GetSubjects
  | ClearPermissions;

export type PermissionControllerEvents = PermissionsStateChange;

export type PermissionControllerMessenger = RestrictedControllerMessenger<
  typeof controllerName,
  PermissionControllerActions,
  PermissionControllerEvents,
  never,
  never
>;

export interface RestrictedMethodImplementation<Params, Result>
  extends JsonRpcMiddleware<Params, Result> {
  (
    req: JsonRpcRequest<Params>,
    res: PendingJsonRpcResponse<Result>,
    next: JsonRpcEngineNextCallback,
    end: JsonRpcEngineEndCallback,
    context?: Readonly<{
      origin: OriginString;
      [key: string]: unknown;
    }>,
  ): void;
}

type RestrictedMethodsOption = Record<
  MethodName,
  RestrictedMethodImplementation<unknown, unknown>
>;

interface PermissionControllerOptions {
  messenger: PermissionControllerMessenger;
  caveatSpecifications: CaveatSpecifications;
  methodPrefix: string;
  restrictedMethods: RestrictedMethodsOption;
  safeMethods: string[];
  state?: Partial<PermissionControllerState>;
}

export class PermissionController extends BaseController<
  typeof controllerName,
  PermissionControllerState
> {
  public readonly methodPrefix: string;

  protected messagingSystem: PermissionControllerMessenger;

  /**
   * Can be namespaced.
   */
  private readonly _restrictedMethods: ReadonlyMap<
    string,
    RestrictedMethodImplementation<unknown, unknown>
  >;

  private readonly _safeMethods: ReadonlySet<string>;

  public get safeMethods(): ReadonlySet<string> {
    return this._safeMethods;
  }

  private readonly _internalMethods: ReadonlySet<string>;

  public get internalMethods(): ReadonlySet<string> {
    return this._internalMethods;
  }

  private readonly _caveatSpecifications: Readonly<CaveatSpecifications>;

  public get caveatSpecifications(): Readonly<CaveatSpecifications> {
    return this._caveatSpecifications;
  }

  protected readonly _caveatTypes: ReadonlySet<string>;

  constructor({
    messenger,
    state = {},
    caveatSpecifications,
    methodPrefix,
    restrictedMethods,
    safeMethods,
  }: PermissionControllerOptions) {
    super({
      name: controllerName,
      metadata: stateMetadata,
      messenger,
      state: { ...defaultState, ...state },
    });

    this._caveatSpecifications = Object.freeze({ ...caveatSpecifications });
    this._caveatTypes = getCaveatTypes(this._caveatSpecifications);
    this._internalMethods = getInternalMethodNames(methodPrefix);
    this._restrictedMethods = getRestrictedMethodMap(restrictedMethods);
    this._safeMethods = new Set(safeMethods);
    this.methodPrefix = methodPrefix;

    // This assignment is redundant, but TypeScript doesn't know that it becomes
    // assigned if we don't do it.
    this.messagingSystem = messenger;

    this.registerMessageHandlers();
  }

  /**
   * Constructor helper for registering this controller's messaging system
   * actions.
   */
  protected registerMessageHandlers(): void {
    this.messagingSystem.registerActionHandler(
      `${controllerName}:getSubjects`,
      () => this.getSubjects(),
    );
    this.messagingSystem.registerActionHandler(
      `${controllerName}:clearPermissions`,
      () => this.clearState(),
    );
  }

  protected clearState(): void {
    this.update((_draftState) => {
      return { ...defaultState };
    });
  }

  getSubjects(): (keyof PermissionControllerSubjects)[] {
    return Object.keys(this.state.subjects);
  }

  getPermission(origin: string, target: string): Permission | undefined {
    return this.state.subjects[origin]?.permissions[target];
  }

  getPermissions(origin: string): Record<MethodName, Permission> | undefined {
    return this.state.subjects[origin]?.permissions;
  }

  hasPermission(origin: string, target: string): boolean {
    return Boolean(this.getPermission(origin, target));
  }

  hasPermissions(origin: string): boolean {
    return Boolean(this.state.subjects[origin]);
  }

  setPermission(origin: string, permission: Permission): void {
    this.update((draftState) => {
      if (!draftState.subjects[origin]) {
        draftState.subjects[origin] = { origin, permissions: {} };
      }
      const { parentCapability: target } = permission;
      // Typecast: ts(2589)
      draftState.subjects[origin].permissions[target] = permission as any;
    });
  }

  /**
   * Adds permissions to the given subject. Overwrites existing identical
   * permissions (same subject and method). Other existing permissions
   * remain unaffected.
   *
   * @param {string} origin - The origin of the grantee subject.
   * @param {Array} newPermissions - The unique, new permissions for the grantee subject.
   */
  setPermissions(
    origin: string,
    permissions: Record<MethodName, Permission>,
  ): void {
    this.update((draftState) => {
      if (!draftState.subjects[origin]) {
        draftState.subjects[origin] = { origin, permissions: {} };
      }
      Object.assign(draftState.subjects[origin].permissions, permissions);
    });
  }

  revokePermission(origin: string, target: string): void {
    this.update((draftState) => {
      if (!draftState.subjects[origin]) {
        throw new UnrecognizedSubjectError(origin);
      }

      const { permissions } = draftState.subjects[origin];
      if (!permissions[target]) {
        throw new PermissionDoesNotExistError(origin, target);
      }

      if (Object.keys(permissions).length > 1) {
        delete permissions[target];
      } else {
        delete draftState.subjects[origin];
      }
    });
  }

  revokeAllPermissions(origin: string): void {
    this.update((draftState) => {
      if (!draftState.subjects[origin]) {
        throw new UnrecognizedSubjectError(origin);
      }
      delete draftState.subjects[origin];
    });
  }

  getCaveat(
    origin: string,
    target: string,
    caveatType: string,
  ): Caveat<Json> | undefined {
    return this.getPermission(origin, target)?.caveats?.find(
      (caveat) => caveat.type === caveatType,
    );
  }

  hasCaveat(origin: string, target: string, caveatType: string): boolean {
    return (
      this.getPermission(origin, target)?.caveats?.some(
        (caveat) => caveat.type === caveatType,
      ) ?? false
    );
  }

  setCaveat(origin: string, target: string, caveat: Caveat<Json>): void {
    this.update((draftState) => {
      const permission = draftState.subjects[origin]?.permissions[target];
      if (!permission) {
        throw new PermissionDoesNotExistError(origin, target);
      }

      // Typecasts: ts(2589)
      if (permission.caveats) {
        const caveatIndex = permission.caveats.findIndex(
          (existingCaveat) => existingCaveat.type === caveat.type,
        );

        if (caveatIndex === -1) {
          permission.caveats.push(caveat as any);
        } else {
          permission.caveats.splice(caveatIndex, 1, caveat as any);
        }
      } else {
        permission.caveats = [caveat as any];
      }
    });
  }

  removeCaveat(origin: string, target: string, caveatType: string): void {
    this.update((draftState) => {
      const permission = draftState.subjects[origin]?.permissions[target];
      if (!permission) {
        throw new PermissionDoesNotExistError(origin, target);
      }

      if (!permission.caveats) {
        throw new PermissionHasNoCaveatsError(origin, target);
      }

      const caveatIndex = permission.caveats.findIndex(
        (existingCaveat) => existingCaveat.type === caveatType,
      );
      if (caveatIndex === -1) {
        throw new CaveatDoesNotExistError(origin, target, caveatType);
      }

      if (permission.caveats.length === 1) {
        permission.caveats = null;
      } else {
        permission.caveats.splice(caveatIndex, 1);
      }
    });
  }

  /**
   * Used for retrieving the key that manages the restricted method
   * associated with the current RPC `method` key.
   *
   * Used to support our namespaced method feature, which allows blocks
   * of methods to be hidden behind a restricted method with a trailing `_` character.
   *
   * @param method string - The requested RPC method.
   * @returns The internal key of the method.
   */
  getMethodKeyFor(method: string): string {
    if (this._restrictedMethods.has(method)) {
      return method;
    }

    const wildCardMethodsWithoutWildCard: Record<string, boolean> = {};
    for (const methodName of this._restrictedMethods.keys()) {
      const wildCardMatch = methodName.match(/(.+)\*$/u);
      if (wildCardMatch) {
        wildCardMethodsWithoutWildCard[wildCardMatch[1]] = true;
      }
    }

    // Check for potentially nested namespaces:
    // Ex: wildzone_
    // Ex: eth_plugin_
    const segments = method.split('_');
    let methodKey = '';

    while (
      segments.length > 0 &&
      !this._restrictedMethods.has(methodKey) &&
      !wildCardMethodsWithoutWildCard[methodKey]
    ) {
      methodKey += `${segments.shift()}_`;
    }

    if (this._restrictedMethods.has(methodKey)) {
      return methodKey;
    } else if (wildCardMethodsWithoutWildCard[methodKey]) {
      return `${methodKey}*`;
    }

    return '';
  }

  grantPermissions(
    subject: SubjectMetadata,
    requestedPermissions: RequestedPermissions,
  ): Record<MethodName, Permission> {
    const { origin } = subject;
    if (!origin || typeof origin !== 'string') {
      throw new InvalidSubjectIdentifierError(origin);
    }

    // Enforce actual approving known methods:
    for (const methodName in requestedPermissions) {
      if (!this.getMethodKeyFor(methodName)) {
        throw methodNotFound({ methodName });
      }
    }

    const permissions: { [methodName: string]: Permission } = {};

    for (const method of Object.keys(requestedPermissions)) {
      if (!this._restrictedMethods.has(this.getMethodKeyFor(method))) {
        throw new PermissionTargetDoesNotExistError(origin, method);
      }

      permissions[method] = new Permission({
        target: method,
        invoker: origin,
        caveats: this.computeCaveats(
          origin,
          method,
          requestedPermissions[method].caveats,
        ),
      });
    }

    this.setPermissions(origin, permissions);
    return permissions;
  }

  /**
   * @param caveats The caveats to validate.
   * @returns Whether the given caveats are valid.
   */
  computeCaveats(
    origin: string,
    target: string,
    caveats?: Caveat<Json>[],
  ): Caveat<Json>[] | undefined {
    const caveatArray = caveats?.map((caveat) => {
      if (!this._caveatTypes.has(caveat.type)) {
        throw new CaveatTypeDoesNotExistError(caveat.type, origin, target);
      }

      if (!('value' in caveat)) {
        throw new CaveatMissingValueError(caveat, origin, target);
      }

      if (Object.keys(caveat).length !== 2) {
        throw new InvalidCaveatFieldsError(caveat, origin, target);
      }

      if (!isValidJson(caveat)) {
        throw new InvalidCaveatJsonError(caveat, origin, target);
      }
      return new Caveat({ type: caveat.type, value: caveat.value });
    });
    return caveatArray && caveatArray.length > 0 ? caveatArray : undefined;
  }
}

function isValidJson(value: unknown): boolean {
  try {
    return deepEqual(value, JSON.parse(JSON.stringify(value)));
  } catch (error) {
    return false;
  }
}

function getCaveatTypes(caveatSpecifications: CaveatSpecifications) {
  return new Set(
    Object.values(caveatSpecifications).map(
      (specification) => specification.type,
    ),
  );
}

function getInternalMethodNames(methodPrefix: string) {
  return new Set([
    `${methodPrefix}getPermissions`,
    `${methodPrefix}requestPermissions`,
  ]);
}

function getRestrictedMethodMap(
  restrictedMethods: RestrictedMethodsOption,
): ReadonlyMap<string, RestrictedMethodImplementation<unknown, unknown>> {
  return Object.entries(restrictedMethods).reduce(
    (methodMap, [methodName, implementation]) => {
      if (!methodName || typeof methodName !== 'string') {
        throw new Error(`Invalid method name: ${methodName}`);
      }

      methodMap.set(methodName, implementation);
      return methodMap;
    },
    new Map(),
  );
}

// TODO: Are we using these?

export interface PermissionsRequestMetadata extends SubjectMetadata {
  id: string;
}

/**
 * Used for prompting the user about a proposed new permission.
 * Includes information about the subject granted, as well as the permissions
 * assigned.
 */
export interface PermissionsRequest {
  stateMetadata: PermissionsRequestMetadata;
  permissions: RequestedPermissions;
}

export type UserApprovalPrompt = (
  permissionsRequest: PermissionsRequest,
) => Promise<RequestedPermissions>;
