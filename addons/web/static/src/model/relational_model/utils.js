/* @odoo-module */

import { markup, onWillDestroy, onWillStart, onWillUpdateProps, useComponent } from "@odoo/owl";
import { evalPartialContext, makeContext } from "@web/core/context";
import { deserializeDate, deserializeDateTime } from "@web/core/l10n/dates";
import { Domain } from "@web/core/domain";
import { x2ManyCommands } from "@web/core/orm_service";
import { Deferred } from "@web/core/utils/concurrency";
import { omit } from "@web/core/utils/objects";
import { effect } from "@web/core/utils/reactive";
import { batched } from "@web/core/utils/timing";
import { orderByToString } from "@web/search/utils/order_by";

export function makeActiveField({
    context,
    invisible,
    readonly,
    required,
    onChange,
    forceSave,
    isHandle,
} = {}) {
    return {
        context: context || "{}",
        invisible: invisible || false,
        readonly: readonly || false,
        required: required || false,
        onChange: onChange || false,
        forceSave: forceSave || false,
        isHandle: isHandle || false,
    };
}

const AGGREGATABLE_FIELD_TYPES = ["float", "integer", "monetary"]; // types that can be aggregated in grouped views

export function addFieldDependencies(activeFields, fields, fieldDependencies = []) {
    for (const field of fieldDependencies) {
        if (field.name in activeFields) {
            patchActiveFields(activeFields[field.name], makeActiveField(field));
        } else {
            activeFields[field.name] = makeActiveField(field);
        }
        if (!fields[field.name]) {
            fields[field.name] = omit(field, [
                "context",
                "invisible",
                "required",
                "readonly",
                "onChange",
            ]);
        }
    }
}

function completeActiveField(activeField, extra) {
    if (extra.related) {
        for (const fieldName in extra.related.activeFields) {
            if (fieldName in activeField.related.activeFields) {
                completeActiveField(
                    activeField.related.activeFields[fieldName],
                    extra.related.activeFields[fieldName]
                );
            } else {
                activeField.related.activeFields[fieldName] = {
                    ...extra.related.activeFields[fieldName],
                };
            }
        }
        Object.assign(activeField.related.fields, extra.related.fields);
    }
}

export function createPropertyActiveField(property) {
    const { type } = property;

    const activeField = makeActiveField();
    if (type === "one2many" || type === "many2many") {
        activeField.related = {
            fields: {
                id: { name: "id", type: "integer" },
                display_name: { name: "display_name", type: "char" },
            },
            activeFields: {
                id: makeActiveField({ readonly: true }),
                display_name: makeActiveField(),
            },
        };
    }
    return activeField;
}

function combineModifiers(mod1, mod2, operator) {
    if (operator === "AND") {
        if (mod1 === false || mod2 === false) {
            return false;
        }
        if (mod1 === true) {
            return mod2;
        }
        if (mod2 === true) {
            return mod1;
        }
        return Domain.and([mod1, mod2]).toString();
    } else if (operator === "OR") {
        if (mod1 === true || mod2 === true) {
            return true;
        }
        if (mod1 === false) {
            return mod2;
        }
        if (mod2 === false) {
            return mod1;
        }
        return Domain.or([mod1, mod2]).toString();
    }
    throw new Error(
        `Operator provided to "combineModifiers" must be "AND" or "OR", received ${operator}`
    );
}

export function patchActiveFields(activeField, patch) {
    activeField.invisible = combineModifiers(activeField.invisible, patch.invisible, "AND");
    activeField.readonly = combineModifiers(activeField.readonly, patch.readonly, "AND");
    activeField.required = combineModifiers(activeField.required, patch.required, "OR");
    activeField.onChange = activeField.onChange || patch.onChange;
    activeField.forceSave = activeField.forceSave || patch.forceSave;
    activeField.isHandle = activeField.isHandle || patch.isHandle;
    // x2manys
    if (patch.related) {
        const related = activeField.related;
        for (const fieldName in patch.related.activeFields) {
            if (fieldName in related.activeFields) {
                patchActiveFields(
                    related.activeFields[fieldName],
                    patch.related.activeFields[fieldName]
                );
            } else {
                related.activeFields[fieldName] = { ...patch.related.activeFields[fieldName] };
            }
        }
        Object.assign(related.fields, patch.related.fields);
    }
    if ("limit" in patch) {
        activeField.limit = patch.limit;
    }
    if ("defaultOrderBy" in patch) {
        activeField.defaultOrderBy = patch.defaultOrderBy;
    }
}

export function extractFieldsFromArchInfo({ fieldNodes, widgetNodes }, fields) {
    const activeFields = {};
    for (const fieldNode of Object.values(fieldNodes)) {
        const fieldName = fieldNode.name;
        const modifiers = fieldNode.modifiers || {};
        const activeField = makeActiveField({
            context: fieldNode.context,
            invisible: modifiers.invisible || modifiers.column_invisible,
            readonly: modifiers.readonly,
            required: modifiers.required,
            onChange: fieldNode.onChange,
            forceSave: fieldNode.forceSave,
            isHandle: fieldNode.isHandle,
        });
        if (["one2many", "many2many"].includes(fields[fieldName].type)) {
            activeField.related = {
                activeFields: {},
                fields: {},
            };
            if (fieldNode.views) {
                const viewDescr = fieldNode.views[fieldNode.viewMode];
                if (viewDescr) {
                    activeField.related = extractFieldsFromArchInfo(viewDescr, viewDescr.fields);
                    activeField.limit = viewDescr.limit;
                    activeField.defaultOrderBy = viewDescr.defaultOrder;
                    if (fieldNode.views.form) {
                        // we already know the form view (it is inline), so add its fields (in invisible)
                        // s.t. they will be sent in the spec for onchange, and create commands returned
                        // by the onchange could return values for those fields (that would be displayed
                        // later if the user opens the form view)
                        const formArchInfo = extractFieldsFromArchInfo(
                            fieldNode.views.form,
                            fieldNode.views.form.fields
                        );
                        for (const fieldName in formArchInfo.activeFields) {
                            const formActiveField = {
                                ...formArchInfo.activeFields[fieldName],
                                invisible: true,
                            };
                            if (fieldName in activeField.related.activeFields) {
                                completeActiveField(
                                    activeField.related.activeFields[fieldName],
                                    formActiveField
                                );
                            } else {
                                activeField.related.activeFields[fieldName] = formActiveField;
                            }
                        }
                        Object.assign(activeField.related.fields, formArchInfo.fields);
                    }
                }
            }
            if (fieldNode.field?.useSubView) {
                activeField.required = false;
            }
        }

        if (fieldName in activeFields) {
            patchActiveFields(activeFields[fieldName], activeField);
        } else {
            activeFields[fieldName] = activeField;
        }

        if (fieldNode.field) {
            let fieldDependencies = fieldNode.field.fieldDependencies;
            if (typeof fieldDependencies === "function") {
                fieldDependencies = fieldDependencies(fieldNode);
            }
            addFieldDependencies(activeFields, fields, fieldDependencies);
        }
    }

    for (const widgetInfo of Object.values(widgetNodes || {})) {
        let fieldDependencies = widgetInfo.widget.fieldDependencies;
        if (typeof fieldDependencies === "function") {
            fieldDependencies = fieldDependencies(widgetInfo);
        }
        addFieldDependencies(activeFields, fields, fieldDependencies);
    }
    return { activeFields, fields };
}

export function getFieldContext(
    record,
    fieldName,
    rawContext = record.activeFields[fieldName].context
) {
    const context = {};
    for (const key in record.context) {
        if (
            !key.startsWith("default_") &&
            !key.startsWith("search_default_") &&
            !key.endsWith("_view_ref")
        ) {
            context[key] = record.context[key];
        }
    }

    return {
        ...context,
        ...record.fields[fieldName].context,
        ...makeContext([rawContext], record.evalContext),
    };
}

export function getFieldsSpec(
    activeFields,
    fields,
    evalContext,
    { parentActiveFields, withInvisible } = {}
) {
    const fieldsSpec = {};
    const properties = [];
    for (const fieldName in activeFields) {
        if (fields[fieldName].relatedPropertyField) {
            continue;
        }
        const { related, limit, defaultOrderBy, invisible } = activeFields[fieldName];
        fieldsSpec[fieldName] = {};
        // X2M
        if (related && (invisible !== true || withInvisible)) {
            fieldsSpec[fieldName].fields = getFieldsSpec(
                related.activeFields,
                related.fields,
                evalContext,
                { parentActiveFields: activeFields, withInvisible }
            );
            fieldsSpec[fieldName].limit = limit;
            if (defaultOrderBy) {
                fieldsSpec[fieldName].order = orderByToString(defaultOrderBy);
            }
        }
        // Properties
        if (fields[fieldName].type === "properties") {
            properties.push(fieldName);
        }
        // M2O
        if (fields[fieldName].type === "many2one" && invisible !== true) {
            fieldsSpec[fieldName].fields = { display_name: {} };
        }
        if (["many2one", "one2many", "many2many"].includes(fields[fieldName].type)) {
            let context = activeFields[fieldName].context;
            if (!context || context === "{}") {
                context = fields[fieldName].context || {};
            } else {
                context = evalPartialContext(context, evalContext);
            }
            if (Object.keys(context).length > 0) {
                fieldsSpec[fieldName].context = context;
            }
        }
        // Reference
        if (fields[fieldName].type === "reference") {
            fieldsSpec[fieldName].fields = { display_name: {} };
        }
    }

    for (const fieldName of properties) {
        const fieldSpec = fieldsSpec[fields[fieldName].definition_record];
        if (fieldSpec) {
            if (!fieldSpec.fields) {
                fieldSpec.fields = {};
            }
            fieldSpec.fields.display_name = {};
        }
    }
    return fieldsSpec;
}

let nextId = 0;
/**
 * @param {string} [prefix]
 * @returns {string}
 */
export function getId(prefix = "") {
    return `${prefix}_${++nextId}`;
}

/**
 * @protected
 * @param {Field | false} field
 * @param {any} value
 * @returns {any}
 */
export function parseServerValue(field, value) {
    switch (field.type) {
        case "char":
        case "text": {
            return value || "";
        }
        case "html": {
            return markup(value || "");
        }
        case "date": {
            return value ? deserializeDate(value) : false;
        }
        case "datetime": {
            return value ? deserializeDateTime(value) : false;
        }
        case "selection": {
            if (value === false) {
                // process selection: convert false to 0, if 0 is a valid key
                const hasKey0 = field.selection.find((option) => option[0] === 0);
                return hasKey0 ? 0 : value;
            }
            return value;
        }
        case "reference": {
            if (value === false) {
                return false;
            }
            return {
                resId: value.id.id,
                resModel: value.id.model,
                displayName: value.display_name,
            };
        }
        case "many2one": {
            if (Array.isArray(value)) {
                return value;
            }
            if (Number.isInteger(value)) {
                // for always invisible many2ones, unity directly returns the id, not a pair
                return [value, ""];
            }
            return value ? [value.id, value.display_name] : false;
        }
        case "properties": {
            return value
                ? value.map((property) => ({
                      ...property,
                      value: parseServerValue(property, property.value ?? false),
                  }))
                : [];
        }
    }
    return value;
}

/**
 * @param {Object} groupData
 * @returns {Object}
 */
export function getAggregatesFromGroupData(groupData, fields) {
    const aggregates = {};
    for (const [key, value] of Object.entries(groupData)) {
        if (key in fields && AGGREGATABLE_FIELD_TYPES.includes(fields[key].type)) {
            aggregates[key] = value;
        }
    }
    return aggregates;
}

/**
 * @param {import("./datapoint").Field} field
 * @param {any} rawValue
 * @returns {string | false}
 */
export function getDisplayNameFromGroupData(field, rawValue) {
    if (field.type === "selection") {
        return Object.fromEntries(field.selection)[rawValue];
    }
    if (["many2one", "many2many"].includes(field.type)) {
        return rawValue ? rawValue[1] : false;
    }
    return rawValue;
}

/**
 * @param {Object} groupData
 * @param {import("./datapoint").Field} field
 * @param {any} rawValue
 * @returns {any}
 */
export function getValueFromGroupData(groupData, field, rawValue) {
    if (["date", "datetime"].includes(field.type)) {
        const range = groupData.range;
        if (!range) {
            return false;
        }
        const dateValue = parseServerValue(field, range.to);
        return dateValue.minus({
            [field.type === "date" ? "day" : "second"]: 1,
        });
    }
    const value = parseServerValue(field, rawValue);
    if (["many2one", "many2many"].includes(field.type)) {
        return value ? value[0] : false;
    }
    return value;
}

/**
 * Onchanges sometimes return update commands for records we don't know (e.g. if
 * they are on a page we haven't loaded yet). We may actually never load them.
 * When this happens, we must still be able to send back those commands to the
 * server when saving. However, we can't send the commands exactly as we received
 * them, since the values they contain have been "unity read". The purpose of this
 * function is to transform field values from the unity format to the format
 * expected by the server for a write.
 * For instance, for a many2one: { id: 3, display_name: "Marc" } => 3.
 */
export function fromUnityToServerValues(values, fields, activeFields) {
    const { CREATE, UPDATE } = x2ManyCommands;
    const serverValues = {};
    for (const fieldName in values) {
        let value = values[fieldName];
        switch (fields[fieldName].type) {
            case "one2many":
            case "many2many":
                value = value.map((c) => {
                    if (c[0] === CREATE || c[0] === UPDATE) {
                        const _fields = activeFields[fieldName].related.fields;
                        const _activeFields = activeFields[fieldName].related.activeFields;
                        return [c[0], c[1], fromUnityToServerValues(c[2], _fields, _activeFields)];
                    }
                    return [c[0], c[1]];
                });
                break;
            case "many2one":
                value = value ? value.id : false;
                break;
            // case "reference":
            //     // TODO
            //     break;
        }
        serverValues[fieldName] = value;
    }
    return serverValues;
}

/**
 * @param {any} field
 * @returns {boolean}
 */
export function isRelational(field) {
    return field && ["one2many", "many2many", "many2one"].includes(field.type);
}

/**
 * This hook should only be used in a component field because it
 * depends on the record props.
 * The callback will be executed once during setup and each time
 * a record value read in the callback changes.
 * @param {(record) => void} callback
 */
export function useRecordObserver(callback) {
    const component = useComponent();
    let alive = true;
    const fct = (props) => {
        const def = new Deferred();
        effect(
            batched(
                async (record) => {
                    if (!alive) {
                        // effect doesn't clean up when the component is unmounted.
                        // We must do it manually.
                        return;
                    }
                    await callback(record);
                    def.resolve();
                },
                () => new Promise((resolve) => window.requestAnimationFrame(resolve))
            ),
            [props.record]
        );
        return def;
    };
    onWillDestroy(() => {
        alive = false;
    });
    onWillStart(() => fct(component.props));
    onWillUpdateProps((props) => {
        if (props.record.id !== component.props.record.id) {
            return fct(props);
        }
    });
}
