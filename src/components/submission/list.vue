<!--
Copyright 2017 ODK Central Developers
See the NOTICE file at the top-level directory of this distribution and at
https://github.com/getodk/central-frontend/blob/master/NOTICE.

This file is part of ODK Central. It is subject to the license terms in
the LICENSE file found in the top-level directory of this distribution and at
https://www.apache.org/licenses/LICENSE-2.0. No part of ODK Central,
including this file, may be copied, modified, propagated, or distributed
except according to the terms contained in the LICENSE file.
-->
<template>
  <div id="submission-list">
    <loading :state="fields.initiallyLoading"/>
    <div v-show="selectedFields != null">
      <div id="submission-list-actions">
        <form class="form-inline" @submit.prevent>
          <submission-filters v-if="!draft" v-model:submitterId="submitterIds"
            v-model:submissionDate="submissionDateRange"
            v-model:reviewState="reviewStates"/>
          <submission-field-dropdown
            v-if="selectedFields != null && fields.selectable.length > 11"
            v-model="selectedFields"/>
          <button id="submission-list-refresh-button" type="button"
            class="btn btn-default" :aria-disabled="refreshing"
            @click="fetchChunk(false, true)">
            <span class="icon-refresh"></span>{{ $t('action.refresh') }}
            <spinner :state="refreshing"/>
          </button>
        </form>
        <submission-download-button :form-version="formVersion"
          :filtered="odataFilter != null" @download="downloadModal.show()"/>
      </div>
      <submission-table v-show="odata.dataExists && odata.value.length !== 0"
        ref="table" :project-id="projectId" :xml-form-id="xmlFormId"
        :draft="draft" :fields="selectedFields"
        @review="reviewModal.show({ submission: $event })"/>
      <p v-show="odata.dataExists && odata.value.length === 0"
        class="empty-table-message">
        {{ odataFilter == null ? $t('submission.emptyTable') : $t('noMatching') }}
      </p>
      <odata-loading-message type="submission"
        :top="top(odata.dataExists ? odata.value.length : 0)"
        :odata="odata"
        :filter="!!odataFilter"
        :refreshing="refreshing"
        :total-count="formVersion.dataExists ? formVersion.submissions : 0"/>
    </div>

    <submission-download v-bind="downloadModal" :form-version="formVersion"
      :odata-filter="odataFilter" @hide="downloadModal.hide()"/>
    <submission-update-review-state v-bind="reviewModal" :project-id="projectId"
      :xml-form-id="xmlFormId" @hide="reviewModal.hide()"
      @success="afterReview"/>
  </div>
</template>

<script>
import { DateTime } from 'luxon';
import { shallowRef, watch, watchEffect } from 'vue';

import Loading from '../loading.vue';
import Spinner from '../spinner.vue';
import OdataLoadingMessage from '../odata-loading-message.vue';
import SubmissionDownload from './download.vue';
import SubmissionDownloadButton from './download-button.vue';
import SubmissionFieldDropdown from './field-dropdown.vue';
import SubmissionFilters from './filters.vue';
import SubmissionTable from './table.vue';
import SubmissionUpdateReviewState from './update-review-state.vue';

import useFields from '../../request-data/fields';
import useQueryRef from '../../composables/query-ref';
import useReviewState from '../../composables/review-state';
import useSubmissions from '../../request-data/submissions';
import { apiPaths } from '../../util/request';
import { arrayQuery } from '../../util/router';
import { modalData } from '../../util/reactivity';
import { noop } from '../../util/util';
import { odataLiteral } from '../../util/odata';
import { useRequestData } from '../../request-data';

export default {
  name: 'SubmissionList',
  components: {
    Loading,
    Spinner,
    SubmissionDownload,
    SubmissionDownloadButton,
    SubmissionFieldDropdown,
    SubmissionFilters,
    SubmissionTable,
    SubmissionUpdateReviewState,
    OdataLoadingMessage
  },
  inject: ['alert'],
  props: {
    projectId: {
      type: String,
      required: true
    },
    xmlFormId: {
      type: String,
      required: true
    },
    draft: Boolean,
    // Returns the value of the $top query parameter.
    top: {
      type: Function,
      default: (loaded) => (loaded < 1000 ? 250 : 1000)
    }
  },
  emits: ['fetch-keys'],
  setup(props) {
    const { form, keys, resourceView } = useRequestData();
    const formVersion = props.draft
      ? resourceView('formDraft', (data) => data.get())
      : form;
    const fields = useFields();
    const { odata, submitters } = useSubmissions();
    // We do not reconcile `odata` with either form.lastSubmission or
    // project.lastSubmission.
    watchEffect(() => {
      if (formVersion.dataExists && odata.dataExists && !odata.filtered)
        formVersion.submissions = odata.count;
    });

    const submitterIds = useQueryRef({
      fromQuery: (query) => {
        const stringIds = arrayQuery(query.submitterId, {
          validator: (value) => /^[1-9]\d*$/.test(value)
        });
        return stringIds.length !== 0
          ? stringIds.map(id => Number.parseInt(id, 10))
          : (submitters.dataExists ? [...submitters.ids] : []);
      },
      toQuery: (value) => ({
        submitterId: value.length === submitters.length
          ? []
          : value.map(id => id.toString())
      })
    });
    watch(() => submitters.dataExists, () => {
      if (submitterIds.value.length === 0 && submitters.length !== 0)
        submitterIds.value = [...submitters.ids];
    });
    const submissionDateRange = useQueryRef({
      fromQuery: (query) => {
        if (typeof query.start === 'string' && typeof query.end === 'string') {
          const start = DateTime.fromISO(query.start);
          const end = DateTime.fromISO(query.end);
          if (start.isValid && end.isValid && start <= end)
            return [start.startOf('day'), end.startOf('day')];
        }
        return [];
      },
      toQuery: (value) => (value.length !== 0
        ? { start: value[0].toISODate(), end: value[1].toISODate() }
        : { start: null, end: null })
    });
    const { reviewStates: allReviewStates } = useReviewState();
    const reviewStates = useQueryRef({
      fromQuery: (query) => arrayQuery(query.reviewState, {
        validator: (value) => allReviewStates.some(reviewState =>
          value === odataLiteral(reviewState)),
        default: () => allReviewStates.map(odataLiteral)
      }),
      toQuery: (value) => ({
        reviewState: value.length === allReviewStates.length ? [] : value
      })
    });

    return {
      form, keys, fields, formVersion, odata, submitters,
      submitterIds, submissionDateRange, reviewStates, allReviewStates
    };
  },
  data() {
    return {
      // selectedFields will be an array of fields. It needs to be shallow so
      // that the elements of the array are not reactive proxies. That's
      // important for SubmissionFieldDropdown, which will do exact equality
      // checks. (The selected fields that it passes to the Multiselect must be
      // among the options.)
      selectedFields: shallowRef(null),
      refreshing: false,
      // Modals
      downloadModal: modalData(),
      reviewModal: modalData()
    };
  },
  computed: {
    filtersOnSubmitterId() {
      if (this.submitterIds.length === 0) return false;
      const selectedAll = this.submitters.dataExists &&
        this.submitterIds.length === this.submitters.length &&
        this.submitterIds.every(id => this.submitters.ids.has(id));
      return !selectedAll;
    },
    odataFilter() {
      if (this.draft) return null;
      const conditions = [];
      if (this.filtersOnSubmitterId) {
        const condition = this.submitterIds
          .map(id => `__system/submitterId eq ${id}`)
          .join(' or ');
        conditions.push(`(${condition})`);
      }
      if (this.submissionDateRange.length !== 0) {
        const start = this.submissionDateRange[0].toISO();
        const end = this.submissionDateRange[1].endOf('day').toISO();
        conditions.push(`__system/submissionDate ge ${start}`);
        conditions.push(`__system/submissionDate le ${end}`);
      }
      if (this.reviewStates.length !== this.allReviewStates.length) {
        const condition = this.reviewStates
          .map(reviewState => `__system/reviewState eq ${reviewState}`)
          .join(' or ');
        conditions.push(`(${condition})`);
      }
      return conditions.length !== 0 ? conditions.join(' and ') : null;
    },
    odataSelect() {
      if (this.selectedFields == null) return null;
      const paths = this.selectedFields.map(({ path }) => path.replace('/', ''));
      paths.unshift('__id', '__system');
      return paths.join(',');
    },
  },
  watch: {
    odataFilter() {
      this.fetchChunk(true);
    },
    selectedFields(_, oldFields) {
      if (oldFields != null) this.fetchChunk(true);
    }
  },
  created() {
    this.fetchData();
  },
  mounted() {
    document.addEventListener('scroll', this.afterScroll);
  },
  beforeUnmount() {
    document.removeEventListener('scroll', this.afterScroll);
  },
  methods: {
    // `clear` indicates whether this.odata should be cleared before sending the
    // request. `refresh` indicates whether the request is a background refresh.
    fetchChunk(clear, refresh = false) {
      this.refreshing = refresh;
      // Are we fetching the first chunk of submissions or the next chunk?
      const first = clear || refresh;
      this.odata.request({
        url: apiPaths.odataSubmissions(
          this.projectId,
          this.xmlFormId,
          this.draft,
          {
            $top: this.top(first ? 0 : this.odata.value.length),
            $count: true,
            $wkt: true,
            $expand:'*',
            $filter: this.odataFilter,
            $select: this.odataSelect,
            $skiptoken: !first ? new URL(this.odata.nextLink).searchParams.get('$skiptoken') : null
          }
        ),
        clear,
        patch: !first
          ? (response) => this.odata.addChunk(response.data)
          : null
      })
        .finally(() => { this.refreshing = false; })
        .catch(noop);

      // emit event to parent component to re-fetch keys if needed
      if (refresh && this.formVersion.keyId != null && this.keys.length === 0)
        this.$emit('fetch-keys');
    },
    fetchData() {
      this.fields.request({
        url: apiPaths.fields(this.projectId, this.xmlFormId, this.draft, {
          odata: true
        })
      })
        .then(() => {
          // We also use 11 in the SubmissionFieldDropdown v-if.
          this.selectedFields = this.fields.selectable.length <= 11
            ? this.fields.selectable
            : this.fields.selectable.slice(0, 10);
        })
        .catch(noop);
      this.fetchChunk(true);
      if (!this.draft) {
        this.submitters.request({
          url: apiPaths.submitters(this.projectId, this.xmlFormId, this.draft)
        }).catch(noop);
      }
    },
    scrolledToBottom() {
      // Using pageYOffset rather than scrollY in order to support IE.
      return window.pageYOffset + window.innerHeight >=
        document.body.offsetHeight - 5;
    },
    // This method may need to change once we support submission deletion.
    afterScroll() {
      if (this.formVersion.dataExists && this.keys.dataExists &&
        this.fields.dataExists && this.odata.dataExists &&
        this.odata.nextLink &&
        !this.odata.awaitingResponse && this.scrolledToBottom())
        this.fetchChunk(false);
    },
    // This method accounts for the unlikely case that the user clicked the
    // refresh button before reviewing the submission. In that case, the
    // submission may have been edited or may no longer be shown.
    afterReview(originalSubmission, reviewState) {
      this.reviewModal.hide();
      this.alert.success(this.$t('alert.updateReviewState'));
      const index = this.odata.value.findIndex(submission =>
        submission.__id === originalSubmission.__id);
      if (index !== -1) {
        this.odata.value[index].__system.reviewState = reviewState;
        this.$refs.table.afterReview(index);
      }
    }
  }
};
</script>

<style lang="scss">
@import '../../assets/scss/variables';

#submission-list {
  // Make sure that there is enough space for the DateRangePicker when it is
  // open.
  min-height: 375px;
}

#submission-list-actions {
  align-items: baseline;
  display: flex;
  flex-wrap: wrap-reverse;

  // If there are filters, then there is already no left margin. But if there
  // aren't filters (in the case of a form draft), then we need to remove the
  // left margin.
  form > :first-child { margin-left: 0; }
}
#submission-field-dropdown {
  margin-left: 15px;
  margin-right: 5px;
}
#submission-list-refresh-button {
  margin-left: 10px;
  margin-right: 5px;
}
#submission-download-button {
  // The bottom margin is for if the download button wraps above the other
  // actions.
  margin-bottom: 10px;
  margin-left: auto;
}
</style>

<i18n lang="json5">
{
  "en": {
    "noMatching": "There are no matching Submissions."
  }
}
</i18n>

<!-- Autogenerated by destructure.js -->
<i18n>
{
  "cs": {
    "noMatching": "Neexistují žádné odpovídající příspěvky."
  },
  "de": {
    "noMatching": "Es gibt keine passenden Übermittlungen."
  },
  "es": {
    "noMatching": "No hay envíos coincidentes."
  },
  "fr": {
    "noMatching": "Il n'y a pas de soumission correspondante."
  },
  "id": {
    "noMatching": "Tidak ada Pengiriman yang cocok."
  },
  "it": {
    "noMatching": "Non sono presenti invii corrispondenti."
  },
  "ja": {
    "noMatching": "照合できる提出済フォームはありません。"
  },
  "sw": {
    "noMatching": "Hakuna Mawasilisho yanayolingana."
  },
  "zh-Hant": {
    "noMatching": "沒有符合的提交內容。"
  }
}
</i18n>
