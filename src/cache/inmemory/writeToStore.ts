import { SelectionSetNode, FieldNode, DocumentNode } from 'graphql';
import { invariant } from 'ts-invariant';

import {
  createFragmentMap,
  FragmentMap,
  getFragmentFromSelection,
} from '../../utilities/graphql/fragments';

import {
  getDefaultValues,
  getFragmentDefinitions,
  getOperationDefinition,
} from '../../utilities/graphql/getFromAST';

import {
  getTypenameFromResult,
  makeReference,
  isField,
  resultKeyNameFromField,
  StoreValue,
} from '../../utilities/graphql/storeUtils';

import { DeepMerger } from '../../utilities/common/mergeDeep';
import { shouldInclude } from '../../utilities/graphql/directives';
import { cloneDeep } from '../../utilities/common/cloneDeep';
import { maybeDeepFreeze } from '../../utilities/common/maybeDeepFreeze';

import { defaultNormalizedCacheFactory } from './entityStore';
import { NormalizedCache, StoreObject } from './types';
import { Policies, StoreValueMergeFunction } from './policies';

export type WriteContext = {
  readonly store: NormalizedCache;
  readonly written: {
    [dataId: string]: SelectionSetNode[];
  };
  readonly variables?: any;
  readonly fragmentMap?: FragmentMap;
  // General-purpose deep-merge function for use during writes.
  merge<T>(existing: T, incoming: T): T;
};

type MergeOverrides = Record<string | number, {
  merge?: StoreValueMergeFunction;
  child?: MergeOverrides;
}>;

export interface StoreWriterConfig {
  policies: Policies;
};

export class StoreWriter {
  private policies: Policies;

  constructor(config: StoreWriterConfig) {
    this.policies = config.policies;
  }

  /**
   * Writes the result of a query to the store.
   *
   * @param result The result object returned for the query document.
   *
   * @param query The query document whose result we are writing to the store.
   *
   * @param store The {@link NormalizedCache} used by Apollo for the `data` portion of the store.
   *
   * @param variables A map from the name of a variable to its value. These variables can be
   * referenced by the query document.
   */
  public writeQueryToStore({
    query,
    result,
    dataId = 'ROOT_QUERY',
    store = defaultNormalizedCacheFactory(),
    variables,
  }: {
    query: DocumentNode;
    result: Object;
    dataId?: string;
    store?: NormalizedCache;
    variables?: Object;
  }): NormalizedCache {
    const operationDefinition = getOperationDefinition(query)!;

    // Any IDs written explicitly to the cache (including ROOT_QUERY, most
    // frequently) will be retained as reachable root IDs on behalf of their
    // owner DocumentNode objects, until/unless evicted for all owners.
    store.retain(dataId);

    // A DeepMerger that merges arrays and objects structurally, but otherwise
    // prefers incoming scalar values over existing values. Used to accumulate
    // fields when processing a single selection set.
    const simpleMerger = new DeepMerger;

    return this.writeSelectionSetToStore({
      result: result || Object.create(null),
      dataId,
      selectionSet: operationDefinition.selectionSet,
      context: {
        store,
        written: Object.create(null),
        merge<T>(existing: T, incoming: T) {
          return simpleMerger.merge(existing, incoming) as T;
        },
        variables: {
          ...getDefaultValues(operationDefinition),
          ...variables,
        },
        fragmentMap: createFragmentMap(getFragmentDefinitions(query)),
      },
    });
  }

  private writeSelectionSetToStore({
    dataId,
    result,
    selectionSet,
    context,
  }: {
    dataId: string;
    result: Record<string, any>;
    selectionSet: SelectionSetNode;
    context: WriteContext;
  }): NormalizedCache {
    const { store, written } = context;

    // Avoid processing the same entity object using the same selection set
    // more than once. We use an array instead of a Set since most entity IDs
    // will be written using only one selection set, so the size of this array
    // is likely to be very small, meaning indexOf is likely to be faster than
    // Set.prototype.has.
    const sets = written[dataId] || (written[dataId] = []);
    if (sets.indexOf(selectionSet) >= 0) return store;
    sets.push(selectionSet);

    const typename =
      // If the result has a __typename, trust that.
      getTypenameFromResult(result, selectionSet, context.fragmentMap) ||
      // If the entity identified by dataId has a __typename in the store,
      // fall back to that.
      store.getFieldValue(dataId, "__typename") as string ||
      // Special dataIds like ROOT_QUERY have a known default __typename.
      this.policies.rootTypenamesById[dataId];

    const processed = this.processSelectionSet({
      result,
      selectionSet,
      context,
      typename,
    });

    if (processed.mergeOverrides) {
      // If processSelectionSet reported any custom merge functions, walk
      // the processed.mergeOverrides structure and preemptively merge
      // incoming values with (possibly non-existent) existing values
      // using the custom function. This function updates processed.result
      // in place with the custom-merged values.
      walkWithMergeOverrides(
        store.get(dataId),
        processed.result,
        processed.mergeOverrides,
      );
    }

    store.merge(dataId, processed.result);

    return store;
  }

  private processSelectionSet({
    result,
    selectionSet,
    context,
    mergeOverrides,
    typename,
  }: {
    result: Record<string, any>;
    selectionSet: SelectionSetNode;
    context: WriteContext;
    mergeOverrides?: MergeOverrides;
    typename: string;
  }): {
    result: StoreObject;
    mergeOverrides?: MergeOverrides;
  } {
    let mergedFields: StoreObject = Object.create(null);
    if (typeof typename === "string") {
      mergedFields.__typename = typename;
    }

    selectionSet.selections.forEach(selection => {
      if (!shouldInclude(selection, context.variables)) {
        return;
      }

      if (isField(selection)) {
        const resultFieldKey = resultKeyNameFromField(selection);
        const value = result[resultFieldKey];

        if (typeof value !== 'undefined') {
          const storeFieldName = this.policies.getStoreFieldName(
            typename,
            selection,
            context.variables,
          );

          const processed = this.processFieldValue(value, selection, context);

          const merge = this.policies.getFieldMergeFunction(
            typename,
            selection,
            context.variables,
          );

          if (merge || processed.mergeOverrides) {
            mergeOverrides = mergeOverrides || Object.create(null);
            mergeOverrides[storeFieldName] = context.merge(
              mergeOverrides[storeFieldName],
              { merge, child: processed.mergeOverrides },
            );
          }

          mergedFields = context.merge(mergedFields, {
            [storeFieldName]: processed.result,
          });

        } else if (
          this.policies.usingPossibleTypes &&
          !(
            selection.directives &&
            selection.directives.some(
              ({ name }) =>
                name && (name.value === 'defer' || name.value === 'client'),
            )
          )
        ) {
          // XXX We'd like to throw an error, but for backwards compatibility's sake
          // we just print a warning for the time being.
          //throw new WriteError(`Missing field ${resultFieldKey} in ${JSON.stringify(result, null, 2).substring(0, 100)}`);
          invariant.warn(
            `Missing field ${resultFieldKey} in ${JSON.stringify(
              result,
              null,
              2,
            ).substring(0, 100)}`,
          );
        }
      } else {
        // This is not a field, so it must be a fragment, either inline or named
        const fragment = getFragmentFromSelection(
          selection,
          context.fragmentMap,
        );

        if (this.policies.fragmentMatches(fragment, typename)) {
          const processed = this.processSelectionSet({
            result,
            selectionSet: fragment.selectionSet,
            context,
            mergeOverrides,
            typename,
          });

          mergedFields = context.merge(mergedFields, processed.result);

          if (processed.mergeOverrides) {
            mergeOverrides = context.merge(
              mergeOverrides,
              processed.mergeOverrides
            );
          }
        }
      }
    });

    return {
      result: mergedFields,
      mergeOverrides,
    };
  }

  private processFieldValue(
    value: any,
    field: FieldNode,
    context: WriteContext,
  ): {
    result: StoreValue;
    mergeOverrides?: MergeOverrides;
  } {
    if (!field.selectionSet || value === null) {
      // In development, we need to clone scalar values so that they can be
      // safely frozen with maybeDeepFreeze in readFromStore.ts. In production,
      // it's cheaper to store the scalar values directly in the cache.
      return {
        result: process.env.NODE_ENV === 'production' ? value : cloneDeep(value),
      };
    }

    if (Array.isArray(value)) {
      let overrides: Record<number, { child: MergeOverrides }>;
      const result = value.map((item, i) => {
        const { result, mergeOverrides } =
          this.processFieldValue(item, field, context);
        if (mergeOverrides) {
          overrides = overrides || [];
          overrides[i] = { child: mergeOverrides };
        }
        return result;
      });
      return { result, mergeOverrides: overrides };
    }

    if (value) {
      const dataId = this.policies.identify(
        value,
        // Since value is a result object rather than a normalized StoreObject,
        // we need to consider aliases when computing its key fields.
        field.selectionSet,
        context.fragmentMap,
      );

      if (typeof dataId === 'string') {
        this.writeSelectionSetToStore({
          dataId,
          result: value,
          selectionSet: field.selectionSet,
          context,
        });
        return { result: makeReference(dataId) };
      }
    }

    return this.processSelectionSet({
      result: value,
      selectionSet: field.selectionSet,
      context,
      typename: getTypenameFromResult(
        value, field.selectionSet, context.fragmentMap),
    });
  }
}

function walkWithMergeOverrides(
  existingObject: StoreObject,
  incomingObject: StoreObject,
  overrides: MergeOverrides,
): void {
  Object.keys(overrides).forEach(name => {
    const { merge, child } = overrides[name];
    const existingValue: any = existingObject && existingObject[name];
    const incomingValue: any = incomingObject && incomingObject[name];
    if (child) {
      // StoreObjects can have multiple layers of child objects/arrays,
      // each layer with its own child fields and override functions.
      walkWithMergeOverrides(existingValue, incomingValue, child);
    }
    if (merge) {
      if (process.env.NODE_ENV !== "production") {
        // It may be tempting to modify existing data directly, for
        // example by pushing more elements onto an existing array, but
        // merge functions are expected to be pure, so it's important that
        // we enforce immutability in development.
        maybeDeepFreeze(existingValue);
      }
      incomingObject[name] = merge(existingValue, incomingValue);
    }
  });
}