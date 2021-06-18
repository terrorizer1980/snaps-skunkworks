import { JsonRpcMiddleware, Json } from 'json-rpc-engine';
import isSubset from 'is-subset';
import equal from 'fast-deep-equal';
import { ethErrors } from 'eth-rpc-errors';
import { Caveat } from './Caveat';

export type CaveatFunction<T, U> = JsonRpcMiddleware<T, U>;

export type CaveatFunctionGenerator<C extends Json, T, U> = (
  caveat: Caveat<C>,
) => CaveatFunction<T, U>;

/**
 * Caveat middleware function generators for all caveat types.
 *
 * A caveat function generator takes a caveat object and returns a caveat
 * middleware function corresponding to the caveat's type and bound to its
 * value.
 */
export const caveatFunctionGenerators = {
  filterResponse,
  forceParams,
  limitResponseLength,
  requireParamsIsSubset,
  requireParamsIsSuperset,
};

/**
 * Require that request.params is a subset of or equal to the caveat value.
 * Arrays are order-dependent, objects are order-independent.
 */
function requireParamsIsSubset(
  caveat: Caveat<Record<string, Json>>,
): CaveatFunction<unknown[] | Record<string, unknown>, unknown> {
  const { value } = caveat;
  return (req, _res, next, _end): void => {
    // Ensure that the params are a subset of or equal to the caveat value
    if (!isSubset(value, req.params)) {
      throw ethErrors.provider.unauthorized({ data: req });
    }

    return next();
  };
}

/**
 * Require that request.params is a superset of or equal to the caveat value.
 * Arrays are order-dependent, objects are order-independent.
 */
function requireParamsIsSuperset(
  caveat: Caveat<Record<string, Json>>,
): CaveatFunction<unknown[] | Record<string, unknown>, unknown> {
  const { value } = caveat;
  return (req, _res, next, _end): void => {
    // Ensure that the params are a superset of or equal to the caveat value
    if (!isSubset(req.params, value)) {
      throw ethErrors.provider.unauthorized({ data: req });
    }

    return next();
  };
}

/*
 * Filters array results deeply.
 */
function filterResponse(
  caveat: Caveat<Json[]>,
): CaveatFunction<unknown, unknown[]> {
  const { value } = caveat;
  return (_req, res, next, _end): void => {
    next((done) => {
      if (Array.isArray(res.result)) {
        res.result = res.result.filter((item) => {
          const findResult = value.find((resultValue: Json) => {
            return equal(resultValue, item);
          });

          return findResult !== undefined;
        });
      }
      done();
    });
  };
}

/*
 * Limits array results to a specific integer length.
 */
function limitResponseLength(
  caveat: Caveat<number>,
): CaveatFunction<unknown, unknown[]> {
  const { value } = caveat;
  return (_req, res, next, _end): void => {
    next((done) => {
      if (Array.isArray(res.result)) {
        res.result = res.result.slice(0, value);
      }
      done();
    });
  };
}

/*
 * Forces the method to be called with the specified params.
 */
function forceParams(
  caveat: Caveat<Json[] | Record<string, Json>>,
): CaveatFunction<unknown, unknown> {
  const { value } = caveat;
  return (req, _res, next, _end): void => {
    req.params = Array.isArray(value) ? [...value] : { ...value };
    return next();
  };
}
