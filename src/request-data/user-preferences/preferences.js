/*
Copyright 2024 ODK Central Developers
See the NOTICE file at the top-level directory of this distribution and at
https://github.com/getodk/central-frontend/blob/master/NOTICE.

This file is part of ODK Central. It is subject to the license terms in
the LICENSE file found in the top-level directory of this distribution and at
https://www.apache.org/licenses/LICENSE-2.0. No part of ODK Central,
including this file, may be copied, modified, propagated, or distributed
except according to the terms contained in the LICENSE file.
*/

import { shallowReactive, isReactive } from 'vue';
import { apiPaths, withAuth } from '../../util/request';
import { noop } from '../../util/util';
import { SitePreferenceNormalizer, ProjectPreferenceNormalizer } from './normalizers';


/*
UserPreferences - for storing user preferences such as the display sort order of listings, etc. The settings are propagated to the
backend and will be loaded into newly created frontend sessions. As such, it doesn't function as a live-sync mechanism between sessions;
preferences only get loaded from the backend once, at login time; thus concurrent sessions don't see eachother's changes. But a newly
created third session will see the amalgamate of the preferences applied in the former two sessions, which may be lightly surprising to
a user, but it keeps things simple.

A preference has a key and a value. It's expressed via a JS object:
- `currentUser.preferences.site.myPreference` for sitewide preferences, or
- `currentUser.preferences.projects[someProjectID].someProjectPreference` for per-project preferences.
The value may be anything json-serializable.

Note that for project preferences, the per-project settings object is autovivicated when referenced. So you don't need to worry about
whether there is already any settings object for a certain project. If there isn't one, it will be generated on the fly when you assign —
for instance, `currentUser.preferences.projects[9000].blooblap = "green"`.

You can also delete a preference; just do `delete currentUser.preferences.projects[9000].blooblap`.

All values in the objects are reactive, so the *idea* is that you would be able to simply reference such a value in a Vue template, and be done!

To set up a preference, there's one thing you need to do: register a "normalizer" for your preference inside `normalizers.js` (more documentation
is to be found there).

One thing to take into account is that every assignment will result in a PUT to the backend (and similarly, any `delete` will result in a
HTTP DELETE request being sent). Thus if you have a preference situation in which the same value can be set repeatedly, you may want to
intervene to compare the value, and only set it in the Preferences object when it has really changed.

Another thing: the propagation to the backend is best-effort — there are no retries, nor is there dirtiness tracking. If the request fails,
for instance due to some transient network error, then the preference is not propagated and a newly created session will not incorporate the
mutation. At the backend, the preferences are stored in the `user_site_preferences` and `user_project_preferences` tables.
*/

export default class UserPreferences {
  #abortControllers;
  #instanceID;
  #session;
  #http;

  constructor(preferenceData, session, http) {
    this.#abortControllers = {};
    this.#instanceID = crypto.randomUUID();
    this.site = this.#makeSiteProxy(preferenceData.site);
    this.projects = this.#makeProjectsProxy(preferenceData.projects);
    this.#session = session;
    this.#http = http;
  }

  #propagate(k, v, projectId) {
    // As we need to be able to have multiple requests in-flight (not canceling eachother), we can't use resource.request() here.
    // However, we want to avoid stacking requests for the same key, so we abort preceding requests for the same key, if any.
    // Note that because locks are origin-scoped, we use a store instantiation identifier to scope them to this app instance.
    const keyLockName = `userPreferences-${this.#instanceID}-keystack-${projectId}-${k}`;
    navigator.locks.request(
      `userPreferences-${this.instanceID}-lockops`,
      () => {
        navigator.locks.request(
          keyLockName,
          { ifAvailable: true },
          (lockForKey) => {
            const aborter = new AbortController();
            if (!lockForKey) {
              // Cancel the preceding HTTP request, a new one supersedes it.
              this.#abortControllers[k].abort();
              return navigator.locks.request(
                keyLockName,
                () => {
                  this.#abortControllers[k] = aborter;
                  return this.#request(k, v, projectId, aborter);
                }
              );
            }
            this.#abortControllers[k] = aborter;
            return this.#request(k, v, projectId, aborter);
          },
        );
        return Promise.resolve(); // return asap with a resolved promise so the outer lockops lock gets released; we don't wan't to wait here for the inner keylock-enveloped requests.
      }
    );
  }

  #request(k, v, projectId, aborter) {
    return this.#http.request(
      withAuth(
        {
          method: (v === null) ? 'DELETE' : 'PUT',
          url: (projectId === null) ? apiPaths.userSitePreferences(k) : apiPaths.userProjectPreferences(projectId, k),
          data: (v === null) ? undefined : { propertyValue: v },
          signal: aborter.signal,
        },
        this.#session.token
      )
    ).catch(noop); // Preference didn't get persisted to the backend. Too bad! We're not doing any retrying.
  }

  #makeSiteProxy(sitePreferenceData) {
    const userPreferences = this;
    return new Proxy(
      shallowReactive(sitePreferenceData),
      {
        /* eslint-disable no-param-reassign */
        deleteProperty(target, prop) {
          SitePreferenceNormalizer.normalizeFn(prop); // throws if prop is not registered
          delete target[prop];
          userPreferences.#propagate(prop, null, null); // DELETE to backend
          return true;
        },
        set(target, prop, value) {
          const normalizedValue = SitePreferenceNormalizer.normalize(prop, value);
          target[prop] = normalizedValue;
          userPreferences.#propagate(prop, normalizedValue, null); // PUT to backend
          return true;
        },
        /* eslint-enable no-param-reassign */
        get(target, prop) {
          return SitePreferenceNormalizer.getProp(target, prop);
        }
      }
    );
  }

  #makeProjectsProxy(projectsPreferenceData) {
    const userPreferences = this;
    return new Proxy(
      projectsPreferenceData,
      {
        deleteProperty() {
          throw new Error('Deleting a project\'s whole property collection is not supported. Delete each property individually, eg "delete preferences.projects[3].foo".');
        },
        set() {
          throw new Error('Directly setting a project\'s whole property collection is not supported. Set each property individually, eg "preferences.projects[3].foo = \'bar\'"');
        },
        get(target, projectId) {
          if (!/^\d+$/.test(projectId)) throw new TypeError(`Not an integer project ID: "${projectId}"`);
          const projectProps = target[projectId];
          if (projectProps === undefined || (!isReactive(projectProps))) {
            /* eslint-disable no-param-reassign */
            target[projectId] = new Proxy(
              // make (potentially autovivicated) props reactive, and front them with a proxy to enable our setters/deleters
              shallowReactive(projectProps === undefined ? {} : projectProps),
              {
                deleteProperty(from, prop) {
                  ProjectPreferenceNormalizer.normalizeFn(prop); // we're calling it just so that it throws if prop is not registered in the form of a normalization function
                  delete from[prop];
                  userPreferences.#propagate(prop, null, projectId); // DELETE to backend
                  return true;
                },
                set(from, prop, propval) {
                  const normalizedValue = ProjectPreferenceNormalizer.normalize(prop, propval);
                  from[prop] = normalizedValue;
                  userPreferences.#propagate(prop, normalizedValue, projectId); // PUT to backend
                  return true;
                },
                get(projectTarget, prop) {
                  return ProjectPreferenceNormalizer.getProp(projectTarget, prop);
                },
              }
            );
            /* eslint-enable no-param-reassign */
          }
          return target[projectId];
        },
      }
    );
  }
}
