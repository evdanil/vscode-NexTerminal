export interface VisibleWhen {
  field: string;
  value: string;
}

export type FormFieldDescriptor =
  | { type: "text"; key: string; label: string; required?: boolean; placeholder?: string; value?: string; scannable?: boolean; hint?: string; visibleWhen?: VisibleWhen }
  | { type: "number"; key: string; label: string; required?: boolean; min?: number; max?: number; placeholder?: string; value?: number; hint?: string; visibleWhen?: VisibleWhen }
  | { type: "select"; key: string; label: string; options: { label: string; value: string }[]; value?: string; hint?: string; visibleWhen?: VisibleWhen }
  | { type: "combobox"; key: string; label: string; suggestions: string[]; placeholder?: string; value?: string; hint?: string; visibleWhen?: VisibleWhen }
  | { type: "checkbox"; key: string; label: string; value?: boolean; hint?: string; visibleWhen?: VisibleWhen }
  | { type: "file"; key: string; label: string; value?: string; hint?: string; visibleWhen?: VisibleWhen }
  /** Raw HTML injected without escaping. `content` must only contain trusted, developer-authored markup — never user-controlled data. */
  | { type: "html"; content: string; visibleWhen?: VisibleWhen };

export interface FormDefinition {
  title: string;
  fields: FormFieldDescriptor[];
}

export type FormValues = Record<string, string | number | boolean | undefined>;

export type FormMessage =
  | { type: "submit"; values: FormValues }
  | { type: "cancel" }
  | { type: "browse"; key: string }
  | { type: "scan"; key: string }
  | { type: "createInline"; key: string };

export type ExtensionMessage =
  | { type: "init"; definition: FormDefinition; values: FormValues }
  | { type: "browseResult"; key: string; path: string }
  | { type: "validationError"; errors: Record<string, string> }
  | { type: "addSelectOption"; key: string; value: string; label: string };
