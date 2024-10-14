<template>
  <div>
    <div v-for="(value, key) in data" :key="key">
      <template v-if="isObject(value)">
        <div>{{ key }}:</div>
        <div class="indent">
          <nested-field :data="value" />
        </div>
      </template>
      <template v-else-if="Array.isArray(value)">
        <div>{{ key }}:</div>
        <div class="indent">
          <ul>
            <li v-for="(item, index) in value" :key="index">
              <template v-if="isObject(item)">
                <nested-field :data="item" />
              </template>
              <template v-else>{{ item }}</template>
            </li>
          </ul>
        </div>
      </template>
      <template v-else>
        <div>{{ key }}: {{ value }}</div>
      </template>
    </div>
  </div>
</template>

<script>
import NestedField from './nested-field.vue';

export default {
  name: 'NestedField',
  components: { NestedField },
  props: {
    data: {
      type: Object,
      required: true
    }
  },
  methods: {
    isObject(value) {
      return value && typeof value === 'object' && !Array.isArray(value);
    }
  }
}
</script>

<style scoped>
.indent {
  margin-left: 20px;
}
</style>
