export type FormFieldDescriptor =
  | { type: "text"; key: string; label: string; required?: boolean; placeholder?: string; value?: string }
  | { type: "number"; key: string; label: string; required?: boolean; min?: number; max?: number; placeholder?: string; value?: number }
  | { type: "select"; key: string; label: string; options: { label: string; value: string }[]; value?: string }
  | { type: "combobox"; key: string; label: string; suggestions: string[]; placeholder?: string; value?: string }
  | { type: "checkbox"; key: string; label: string; value?: boolean }
  | { type: "file"; key: string; label: string; value?: string };

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
