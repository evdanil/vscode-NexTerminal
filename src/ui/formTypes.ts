export interface VisibleWhen {
  field: string;
  value: string;
}

export type FormFieldDescriptor =
  | { type: "text"; key: string; label: string; required?: boolean; placeholder?: string; value?: string; visibleWhen?: VisibleWhen }
  | { type: "number"; key: string; label: string; required?: boolean; min?: number; max?: number; placeholder?: string; value?: number; visibleWhen?: VisibleWhen }
  | { type: "select"; key: string; label: string; options: { label: string; value: string }[]; value?: string; visibleWhen?: VisibleWhen }
  | { type: "combobox"; key: string; label: string; suggestions: string[]; placeholder?: string; value?: string; visibleWhen?: VisibleWhen }
  | { type: "checkbox"; key: string; label: string; value?: boolean; visibleWhen?: VisibleWhen }
  | { type: "file"; key: string; label: string; value?: string; visibleWhen?: VisibleWhen };

export interface FormDefinition {
  title: string;
  fields: FormFieldDescriptor[];
}

export type FormValues = Record<string, string | number | boolean | undefined>;

export type FormMessage =
  | { type: "submit"; values: FormValues }
  | { type: "cancel" }
  | { type: "browse"; key: string }
  | { type: "createInline"; key: string };

export type ExtensionMessage =
  | { type: "init"; definition: FormDefinition; values: FormValues }
  | { type: "browseResult"; key: string; path: string }
  | { type: "validationError"; errors: Record<string, string> }
  | { type: "addSelectOption"; key: string; value: string; label: string };
