import { useState, useCallback, useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useLoaderData,
  useActionData,
  useFetcher,
  useRevalidator,
  useSubmit,
  useNavigation,
  useRouteError,
  isRouteErrorResponse,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Button,
  Banner,
  Tag,
  InlineStack,
  BlockStack,
  Text,
  DataTable,
  Autocomplete,
  Icon,
  ButtonGroup,
  DropZone,
  Thumbnail,
  Modal,
  Checkbox,
  Select,
  RadioButton,
  Divider,
} from "@shopify/polaris";
import { SearchIcon, PlusIcon, DeleteIcon } from "@shopify/polaris-icons";

import { authenticate } from "../shopify.server";
import {
  createProduct,
  getVendors,
  getMetafieldDefinitions,
  getExistingOptionValues,
  getPublications,
  publishProductToChannels,
} from "../services/shopify-api/products.server";
import type {
  ProductOption,
  MetafieldInput,
  MetafieldDefinition,
  ExistingOptionValues,
  Publication,
} from "../services/shopify-api/products.server";
import {
  getLocations,
  type Location,
} from "../services/shopify-api/locations.server";
import { MENS_SIZES, WOMENS_SIZES } from "../utils/constants";
import { stageAndUpload, createFile } from "../utils/shopify-upload";

/**
 * Find the POS publication from the store's list. Shopify calls it "Point of
 * Sale" — matching by name (case-insensitive contains "point of sale" or
 * "pos") covers every naming Shopify has used over the years.
 */
function findPosPublicationId(publications: Publication[]): string | null {
  const pos = publications.find(
    (p) =>
      /point of sale/i.test(p.name) ||
      /\bpos\b/i.test(p.name),
  );
  return pos?.id ?? null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  // Run the Shopify metadata queries in parallel, each behind the
  // shopify-cache.server.ts TTL cache.
  const [vendors, metafieldDefs, existingOptions, publications, locations] =
    await Promise.all([
      getVendors(admin, session.shop),
      getMetafieldDefinitions(admin, session.shop),
      getExistingOptionValues(admin, session.shop),
      getPublications(admin, session.shop),
      getLocations(admin, session.shop).catch(() => [] as Location[]),
    ]);

  // Default publication selection: POS only. Everything else (Online Store,
  // Shop, etc.) is off by default so products are internal-first.
  const posId = findPosPublicationId(publications);
  const defaultPublicationIds = posId ? [posId] : [];

  return json({
    vendors,
    metafieldDefs,
    existingOptions,
    publications,
    locations,
    defaultPublicationIds,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Refresh vendor list — clears the cached copy so the NEXT loader run
  // (triggered by revalidation on the client) pulls fresh from Shopify.
  // Used when a user adds a vendor outside our app (directly in the
  // Shopify admin) and needs to see it in the dropdown.
  if (intent === "refresh-vendors") {
    const { invalidateCache, CACHE_KEYS } = await import(
      "../services/cache/shopify-cache.server"
    );
    await invalidateCache(session.shop, [
      CACHE_KEYS.VENDORS,
      CACHE_KEYS.OPTION_VALUES,
    ]);
    return json({ refreshed: true as const });
  }

  // Same pattern for metafield definitions — the user may add a new
  // metafield definition in Shopify admin and want it to show up here.
  if (intent === "refresh-metafields") {
    const { invalidateCache, CACHE_KEYS } = await import(
      "../services/cache/shopify-cache.server"
    );
    await invalidateCache(session.shop, [CACHE_KEYS.METAFIELD_DEFINITIONS]);
    return json({ refreshed: true as const });
  }

  const title = formData.get("title") as string;
  const vendor = formData.get("vendor") as string;
  const price = formData.get("price") as string;
  const cost = formData.get("cost") as string;
  const skuPrefix = formData.get("skuPrefix") as string;
  const imageUrl = formData.get("imageUrl") as string;
  const selectedPublications = JSON.parse(
    (formData.get("publications") as string) || "[]",
  ) as string[];
  const options = JSON.parse(
    (formData.get("options") as string) || "[]",
  ) as ProductOption[];
  const metafields = JSON.parse(
    (formData.get("metafields") as string) || "[]",
  ) as MetafieldInput[];
  const tags = JSON.parse(
    (formData.get("tags") as string) || "[]",
  ) as string[];
  // Starting inventory: optional. Shape matches CreateProductInput.initialInventory:
  // { [optionValues joined by "/"]: { [locationId]: quantity } }
  const initialInventory = JSON.parse(
    (formData.get("initialInventory") as string) || "{}",
  ) as Record<string, Record<string, number>>;

  if (!title || !vendor || !price) {
    return json({
      error: "Please fill in all required fields (title, vendor, price).",
    });
  }

  try {
    const result = await createProduct(admin, {
      title,
      vendor,
      options,
      price,
      cost: cost || undefined,
      skuPrefix: skuPrefix || undefined,
      metafields: metafields.length > 0 ? metafields : undefined,
      imageUrl: imageUrl || undefined,
      tags: tags.length > 0 ? tags : undefined,
      initialInventory:
        Object.keys(initialInventory).length > 0 ? initialInventory : undefined,
      shop: session.shop,
    });

    if (result.userErrors?.length > 0) {
      return json({
        error: result.userErrors
          .map((e: { message: string }) => e.message)
          .join(", "),
      });
    }

    const variantCount = result.product?.variants?.edges?.length || 0;
    const productId = result.product?.id;
    const productNumericId = productId
      ? String(productId).replace("gid://shopify/Product/", "")
      : null;

    // Publish to selected sales channels. Failures here are non-fatal
    // (the product DID get created), but they're surfaced as a warning
    // so the user knows to retry or check app scopes. The most common
    // cause of "Access denied for publishablePublish" is a missing
    // write_publications scope — which requires a reinstall to grant.
    let publicationWarning: string | null = null;
    if (productId && selectedPublications.length > 0) {
      try {
        const { failures } = await publishProductToChannels(
          admin,
          productId,
          selectedPublications,
        );
        if (failures.length > 0) {
          publicationWarning = `Product created, but couldn't publish to ${failures.length} channel(s): ${failures
            .map((f) => f.reason)
            .join("; ")}`;
          console.error("Publication failures:", failures);
        }
      } catch (error) {
        publicationWarning = `Product created, but publication to channels errored: ${error}`;
        console.error("Failed to publish to channels:", error);
      }
    }

    return json({
      success: true,
      variantCount,
      productId,
      productNumericId,
      title,
      intent,
      publicationWarning,
    });
  } catch (error) {
    return json({ error: `Failed to create product: ${error}` });
  }
};

interface OptionState {
  id: string;
  name: string;
  values: string[];
  newValue: string;
}

function getInitialState() {
  return {
    title: "",
    vendor: "",
    vendorInput: "",
    price: "",
    cost: "",
    skuPrefix: "",
    metafieldValues: {} as Record<string, string>,
    options: [
      { id: "size", name: "Size", values: [], newValue: "" },
      { id: "color", name: "Color", values: [], newValue: "" },
    ] as OptionState[],
    imageFile: null as File | null,
    imagePreview: "",
    uploadedImageUrl: "",
  };
}

export default function ProductBuilder() {
  const loaderData = useLoaderData<typeof loader>();
  const vendors = loaderData?.vendors || [];
  const metafieldDefs = (loaderData?.metafieldDefs || []) as MetafieldDefinition[];
  // Skip metafield definitions that don't belong in the Product Builder:
  //   - Size / Color: already handled as product options / variants, so
  //     showing them as metafields gives two places to edit the same value.
  //   - Product rating / rating count: Shopify's standard review
  //     metafields, written by review apps at runtime — nothing the
  //     merchandiser should ever fill in on create.
  const isBuilderHiddenMetafield = (def: MetafieldDefinition): boolean => {
    const hay = `${def.namespace} ${def.key} ${def.name}`.toLowerCase();
    return (
      /\bsize\b|\bsizes\b/.test(hay) ||
      /\bcolor\b|\bcolour\b|\bcolors\b|\bcolours\b/.test(hay) ||
      /\brating\b|\bratings\b/.test(hay)
    );
  };
  const visibleMetafieldDefs = metafieldDefs.filter(
    (def) => !isBuilderHiddenMetafield(def),
  );
  const existingOptions = (loaderData?.existingOptions || {}) as ExistingOptionValues;
  const publications = (loaderData?.publications || []) as Publication[];
  const locations = (loaderData?.locations || []) as Location[];
  const defaultPublicationIds = (loaderData?.defaultPublicationIds ||
    []) as string[];
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  // Separate fetcher for the "refresh vendors" action so it doesn't collide
  // with the main form-submit navigation lifecycle.
  const refreshFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const isRefreshingVendors = refreshFetcher.state !== "idle";

  const handleRefreshVendors = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "refresh-vendors");
    refreshFetcher.submit(fd, { method: "post" });
  }, [refreshFetcher]);

  const handleRefreshMetafields = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "refresh-metafields");
    refreshFetcher.submit(fd, { method: "post" });
  }, [refreshFetcher]);

  // When the refresh fetcher finishes, re-run the loader so the new vendor
  // list reaches the component.
  useEffect(() => {
    if (
      refreshFetcher.state === "idle" &&
      refreshFetcher.data &&
      "refreshed" in refreshFetcher.data
    ) {
      revalidator.revalidate();
    }
  }, [refreshFetcher.state, refreshFetcher.data, revalidator]);

  const [title, setTitle] = useState("");
  const [vendor, setVendor] = useState("");
  const [vendorInput, setVendorInput] = useState("");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [skuPrefix, setSkuPrefix] = useState("");
  const [metafieldValues, setMetafieldValues] = useState<Record<string, string>>({});
  // For file_reference / list.file_reference metafields (e.g. cutting
  // ticket). Parallel to metafieldValues — holds user-visible state
  // (filename, uploading flag, resolved gid) while metafieldValues holds
  // the final serialized value we send to Shopify (single gid string, or
  // JSON array of gids for list types).
  type MetafieldFile = {
    // Stable ID — matching uploads back to their state entry by name is
    // ambiguous when a user drops two files with the same filename into
    // a list.file_reference; a UUID keeps each upload distinct.
    id: string;
    name: string;
    gid: string; // empty while uploading
    uploading: boolean;
    error?: string;
  };
  const [metafieldFiles, setMetafieldFiles] = useState<
    Record<string, MetafieldFile[]>
  >({});
  // Block Save while any metafield file is still uploading — the serialized
  // gid isn't in metafieldValues yet, so submitting now would drop the file.
  const anyMetafieldUploading = Object.values(metafieldFiles).some((arr) =>
    arr.some((f) => f.uploading),
  );
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState("");
  const [uploadedImageUrl, setUploadedImageUrl] = useState("");

  // Tagging questions
  const [isFLWBrand, setIsFLWBrand] = useState<"yes" | "no" | "">("");
  const [isFLWCore, setIsFLWCore] = useState<"yes" | "no" | "">("");
  const [hasSeason, setHasSeason] = useState<"yes" | "no" | "">("");
  const [selectedSeason, setSelectedSeason] = useState("");

  const [options, setOptions] = useState<OptionState[]>([
    { id: "size", name: "Size", values: [], newValue: "" },
    { id: "color", name: "Color", values: [], newValue: "" },
  ]);

  // Sales channels — default to POS only (the server-computed default).
  // Other channels (Online Store, Shop, etc.) stay off by default so new
  // products are internal-first; users can explicitly opt-in per product.
  const [selectedPubs, setSelectedPubs] =
    useState<string[]>(defaultPublicationIds);

  // Starting inventory — optional. User toggles it on, then fills in a
  // per-variant-per-location qty table. When off, no inventory is set and
  // variants start at 0 everywhere.
  const [setStartingInventory, setSetStartingInventory] = useState(false);
  const [startingInventory, setStartingInventory_] = useState<
    Record<string, Record<string, number>>
  >({});

  // Add vendor modal
  const [addVendorModalOpen, setAddVendorModalOpen] = useState(false);
  const [newVendorName, setNewVendorName] = useState("");

  // Success state for "Save & Create Another"
  const [successBanner, setSuccessBanner] = useState<{
    title: string;
    productNumericId: string;
    variantCount: number;
  } | null>(null);

  // Reset every form field back to its pristine state. Used by both
  // "Save & Create Another" (auto-invoked after a successful save) and
  // "Create new product" on the post-saveAndOpen banner.
  const resetForm = useCallback(() => {
    setTitle("");
    setVendor("");
    setVendorInput("");
    setPrice("");
    setCost("");
    setSkuPrefix("");
    setMetafieldValues({});
    setMetafieldFiles({});
    setImageFile(null);
    setImagePreview("");
    setUploadedImageUrl("");
    setOptions([
      { id: "size", name: "Size", values: [], newValue: "" },
      { id: "color", name: "Color", values: [], newValue: "" },
    ]);
    setSelectedPubs(defaultPublicationIds);
    setSetStartingInventory(false);
    setStartingInventory_({});
    setIsFLWBrand("");
    setIsFLWCore("");
    setHasSeason("");
    setSelectedSeason("");
    setSuccessBanner(null);
  }, [defaultPublicationIds]);

  // Clear form on successful "Save & Create Another"
  useEffect(() => {
    if (
      actionData &&
      "success" in actionData &&
      actionData.intent === "saveAndNew"
    ) {
      setSuccessBanner({
        title: String(actionData.title),
        productNumericId: String(actionData.productNumericId || ""),
        variantCount: Number(actionData.variantCount),
      });
      resetForm();
    }
  }, [actionData, resetForm]);

  // Build tags from tagging questions
  const computedTags: string[] = [];
  if (isFLWBrand === "yes") {
    computedTags.push("FLW Brand");
    if (isFLWCore === "yes") computedTags.push("FLWCore");
  } else if (isFLWBrand === "no") {
    computedTags.push("Partner Brand");
    if (hasSeason === "yes" && selectedSeason) computedTags.push(selectedSeason);
  }

  // Publication toggle handler
  const handleTogglePub = useCallback((pubId: string) => {
    setSelectedPubs((prev) =>
      prev.includes(pubId) ? prev.filter((id) => id !== pubId) : [...prev, pubId],
    );
  }, []);

  // Image handling
  const handleDropImage = useCallback((_dropFiles: File[], acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      const file = acceptedFiles[0];
      setImageFile(file);
      setImagePreview(URL.createObjectURL(file));
      setUploadedImageUrl("");
    }
  }, []);

  const handleRemoveImage = useCallback(() => {
    setImageFile(null);
    setImagePreview("");
    setUploadedImageUrl("");
  }, []);

  // Upload image via staged upload before submitting product. Images go
  // through stage+POST only — Shopify's product mutations accept the
  // resulting `resourceUrl` directly, no fileCreate needed.
  const uploadImage = useCallback(async (): Promise<string> => {
    if (!imageFile) return "";
    if (uploadedImageUrl) return uploadedImageUrl;

    try {
      const target = await stageAndUpload(imageFile, "IMAGE");
      setUploadedImageUrl(target.resourceUrl);
      return target.resourceUrl;
    } catch (error) {
      console.error("Image upload failed:", error);
      return "";
    }
  }, [imageFile, uploadedImageUrl]);

  // Vendor autocomplete - include "(+ Add new vendor)" option
  const ADD_VENDOR_VALUE = "__ADD_NEW_VENDOR__";
  const vendorOptions = [
    ...vendors
      .filter(
        (v: string) =>
          !vendorInput || v.toLowerCase().includes(vendorInput.toLowerCase()),
      )
      .map((v: string) => ({ value: v, label: v })),
    { value: ADD_VENDOR_VALUE, label: "+ Add new vendor" },
  ];

  const handleVendorSelect = useCallback(
    (selected: string[]) => {
      const val = selected[0] || "";
      if (val === ADD_VENDOR_VALUE) {
        setAddVendorModalOpen(true);
        return;
      }
      setVendor(val);
      setVendorInput(val);
    },
    [],
  );

  const handleAddVendorConfirm = useCallback(() => {
    if (newVendorName.trim()) {
      setVendor(newVendorName.trim());
      setVendorInput(newVendorName.trim());
    }
    setAddVendorModalOpen(false);
    setNewVendorName("");
  }, [newVendorName]);

  // Size quick-fill
  const handleFillMens = useCallback(() => {
    setOptions((prev) =>
      prev.map((opt) =>
        opt.name === "Size" ? { ...opt, values: [...MENS_SIZES] } : opt,
      ),
    );
  }, []);

  const handleFillWomens = useCallback(() => {
    setOptions((prev) =>
      prev.map((opt) =>
        opt.name === "Size" ? { ...opt, values: [...WOMENS_SIZES] } : opt,
      ),
    );
  }, []);

  // Option management
  const handleAddValue = useCallback((optionId: string) => {
    setOptions((prev) =>
      prev.map((opt) => {
        if (opt.id !== optionId || !opt.newValue.trim()) return opt;
        if (opt.values.includes(opt.newValue.trim()))
          return { ...opt, newValue: "" };
        return {
          ...opt,
          values: [...opt.values, opt.newValue.trim()],
          newValue: "",
        };
      }),
    );
  }, []);

  const handleRemoveValue = useCallback((optionId: string, value: string) => {
    setOptions((prev) =>
      prev.map((opt) =>
        opt.id === optionId
          ? { ...opt, values: opt.values.filter((v) => v !== value) }
          : opt,
      ),
    );
  }, []);

  const handleOptionNameChange = useCallback(
    (optionId: string, name: string) => {
      setOptions((prev) =>
        prev.map((opt) => (opt.id === optionId ? { ...opt, name } : opt)),
      );
    },
    [],
  );

  const handleNewValueChange = useCallback(
    (optionId: string, value: string) => {
      setOptions((prev) =>
        prev.map((opt) =>
          opt.id === optionId ? { ...opt, newValue: value } : opt,
        ),
      );
    },
    [],
  );

  const handleAddOption = useCallback(() => {
    setOptions((prev) => [
      ...prev,
      { id: `option-${Date.now()}`, name: "", values: [], newValue: "" },
    ]);
  }, []);

  const handleRemoveOption = useCallback((optionId: string) => {
    setOptions((prev) => prev.filter((opt) => opt.id !== optionId));
  }, []);

  // Add existing option value
  const handleAddExistingValue = useCallback(
    (optionId: string, value: string) => {
      setOptions((prev) =>
        prev.map((opt) => {
          if (opt.id !== optionId) return opt;
          if (opt.values.includes(value)) return opt;
          return { ...opt, values: [...opt.values, value] };
        }),
      );
    },
    [],
  );

  const handleMetafieldChange = useCallback((key: string, value: string) => {
    setMetafieldValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  // After any change to the uploaded file list for a given metafield key,
  // recompute the serialized value we send to Shopify:
  //   file_reference       -> the single gid, or ""
  //   list.file_reference  -> JSON array of gids, or "" (empty -> drop)
  const syncMetafieldFileValue = useCallback(
    (metaKey: string, isList: boolean, files: MetafieldFile[]) => {
      const ready = files.filter((f) => f.gid && !f.uploading);
      // Empty → "" so the submit filter drops the metafield altogether;
      // sending "[]" would create a list metafield with zero entries,
      // which is noise.
      const value =
        ready.length === 0
          ? ""
          : isList
            ? JSON.stringify(ready.map((f) => f.gid))
            : ready[0].gid;
      setMetafieldValues((prev) => ({ ...prev, [metaKey]: value }));
    },
    [],
  );

  // Patch a single in-flight upload (keyed by stable id) and resync the
  // serialized metafield value. Used by both the success and failure
  // paths of the upload callback.
  const patchMetafieldFile = useCallback(
    (
      metaKey: string,
      isList: boolean,
      fileId: string,
      patch: Partial<MetafieldFile>,
    ) => {
      setMetafieldFiles((prev) => {
        const cur = prev[metaKey] ?? [];
        const next = cur.map((f) => (f.id === fileId ? { ...f, ...patch } : f));
        syncMetafieldFileValue(metaKey, isList, next);
        return { ...prev, [metaKey]: next };
      });
    },
    [syncMetafieldFileValue],
  );

  // Full client-side upload for a metafield file: stage → POST bytes →
  // fileCreate → store gid. Mutates the entry identified by fileId so the
  // UI reflects uploading / failed state without a second source of truth.
  const uploadMetafieldFile = useCallback(
    async (
      metaKey: string,
      isList: boolean,
      fileId: string,
      file: File,
    ): Promise<void> => {
      try {
        const target = await stageAndUpload(file, "FILE");
        const gid = await createFile(
          target.resourceUrl,
          file.name,
          file.type,
        );
        patchMetafieldFile(metaKey, isList, fileId, {
          gid,
          uploading: false,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("Metafield file upload failed:", msg);
        patchMetafieldFile(metaKey, isList, fileId, {
          uploading: false,
          error: msg,
        });
      }
    },
    [patchMetafieldFile],
  );

  const handleDropMetafieldFiles = useCallback(
    (metaKey: string, isList: boolean, acceptedFiles: File[]) => {
      if (acceptedFiles.length === 0) return;
      // `crypto.randomUUID` is widely available in modern browsers; the
      // fallback covers older mobile Safari in case someone's on iOS 14.
      const makeId = (): string =>
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const pending = acceptedFiles.map((f) => ({
        id: makeId(),
        file: f,
      }));
      const toAdd: MetafieldFile[] = pending.map(({ id, file }) => ({
        id,
        name: file.name,
        gid: "",
        uploading: true,
      }));
      setMetafieldFiles((prev) => {
        // Single file_reference replaces any prior entry; list appends.
        const existing = isList ? (prev[metaKey] ?? []) : [];
        return { ...prev, [metaKey]: [...existing, ...toAdd] };
      });
      for (const { id, file } of pending) {
        void uploadMetafieldFile(metaKey, isList, id, file);
      }
    },
    [uploadMetafieldFile],
  );

  const handleRemoveMetafieldFile = useCallback(
    (metaKey: string, isList: boolean, fileId: string) => {
      setMetafieldFiles((prev) => {
        const cur = prev[metaKey] ?? [];
        const next = cur.filter((f) => f.id !== fileId);
        syncMetafieldFileValue(metaKey, isList, next);
        return { ...prev, [metaKey]: next };
      });
    },
    [syncMetafieldFileValue],
  );

  // Submit
  const handleSubmit = useCallback(
    async (intent: string) => {
      const activeOptions: ProductOption[] = options
        .filter((opt) => opt.name && opt.values.length > 0)
        .map((opt) => ({ name: opt.name, values: opt.values }));

      const metafields: MetafieldInput[] = Object.entries(metafieldValues)
        .filter(([, value]) => value.trim())
        .map(([key, value]) => {
          const def = metafieldDefs.find(
            (d) => `${d.namespace}.${d.key}` === key,
          );
          return {
            namespace: def?.namespace || "",
            key: def?.key || "",
            value,
            type: def?.type || "single_line_text_field",
          };
        })
        .filter((mf) => mf.namespace && mf.key);

      // Upload image first if present
      let imageUrl = "";
      if (imageFile) {
        imageUrl = await uploadImage();
      }

      const formData = new FormData();
      formData.set("intent", intent);
      formData.set("title", title);
      formData.set("vendor", vendor || vendorInput);
      formData.set("price", price);
      formData.set("cost", cost);
      formData.set("skuPrefix", skuPrefix);
      formData.set("options", JSON.stringify(activeOptions));
      formData.set("metafields", JSON.stringify(metafields));
      if (imageUrl) formData.set("imageUrl", imageUrl);
      formData.set("publications", JSON.stringify(selectedPubs));
      formData.set("tags", JSON.stringify(computedTags));
      // Only send starting inventory when the toggle is on. We also drop
      // any zero-qty entries on the client so the backend payload is lean.
      if (setStartingInventory) {
        const nonZero: Record<string, Record<string, number>> = {};
        for (const [variantKey, perLoc] of Object.entries(startingInventory)) {
          for (const [locId, qty] of Object.entries(perLoc)) {
            if (qty && qty > 0) {
              if (!nonZero[variantKey]) nonZero[variantKey] = {};
              nonZero[variantKey][locId] = qty;
            }
          }
        }
        if (Object.keys(nonZero).length > 0) {
          formData.set("initialInventory", JSON.stringify(nonZero));
        }
      }
      submit(formData, { method: "post" });
    },
    [
      title,
      vendor,
      vendorInput,
      price,
      cost,
      skuPrefix,
      options,
      selectedPubs,
      computedTags,
      metafieldValues,
      metafieldDefs,
      imageFile,
      uploadImage,
      submit,
      setStartingInventory,
      startingInventory,
    ],
  );

  // Variant preview
  const activeOptions = options.filter(
    (opt) => opt.name && opt.values.length > 0,
  );
  const variantPreview: string[][] = [];

  if (activeOptions.length > 0) {
    const generateCombos = (opts: OptionState[]): string[][] => {
      if (opts.length === 0) return [[]];
      const [first, ...rest] = opts;
      const restCombos = generateCombos(rest);
      const combos: string[][] = [];
      for (const val of first.values) {
        for (const rc of restCombos) {
          combos.push([val, ...rc]);
        }
      }
      return combos;
    };
    const combos = generateCombos(activeOptions);
    for (const combo of combos) {
      const skuParts = combo.map((v) =>
        v.toUpperCase().replace(/\s+/g, ""),
      );
      const sku = skuPrefix ? [skuPrefix, ...skuParts].join("-") : "";
      variantPreview.push([...combo, sku, price ? `$${price}` : ""]);
    }
  } else {
    // Zero-option (single-variant) product — one default row so the
    // variant preview + starting-inventory table still render something.
    const sku = skuPrefix ?? "";
    variantPreview.push([sku, price ? `$${price}` : ""]);
  }

  const previewHeadings = [
    ...activeOptions.map((o) => o.name),
    "SKU",
    "Price",
  ];
  const previewContentTypes: Array<"text" | "numeric"> = [
    ...activeOptions.map(() => "text" as const),
    "text" as const,
    "numeric" as const,
  ];

  const effectiveVendor = vendor || vendorInput;

  // Get suggested values for an option from existing store data
  const getSuggestedValues = (optionName: string): string[] => {
    if (!optionName) return [];
    // Look for exact match first, then case-insensitive
    const values =
      existingOptions[optionName] ||
      existingOptions[
        Object.keys(existingOptions).find(
          (k) => k.toLowerCase() === optionName.toLowerCase(),
        ) || ""
      ];
    return values || [];
  };

  return (
    <Page
      title="Product Builder"
      subtitle="Create new products with auto-generated variants"
    >
      <Layout>
        {/* Success banner for Save & Create Another */}
        {successBanner && (
          <Layout.Section>
            <Banner
              tone="success"
              onDismiss={() => setSuccessBanner(null)}
              action={
                successBanner.productNumericId
                  ? {
                      content: "View product",
                      url: `shopify:admin/products/${successBanner.productNumericId}`,
                    }
                  : undefined
              }
            >
              &ldquo;{successBanner.title}&rdquo; created with{" "}
              {successBanner.variantCount} variant
              {successBanner.variantCount !== 1 ? "s" : ""}!
            </Banner>
          </Layout.Section>
        )}

        {/* Action error banner stays near the top so problems are visible */}
        {actionData && "error" in actionData && (
          <Layout.Section>
            <Banner tone="critical">{String(actionData.error)}</Banner>
          </Layout.Section>
        )}
        {/* Publication failed — shown after a successful product create
            when the publishablePublish mutation didn't land on one or
            more channels. Most common cause is a missing
            write_publications scope, which needs a reinstall to grant. */}
        {actionData &&
          "publicationWarning" in actionData &&
          actionData.publicationWarning && (
            <Layout.Section>
              <Banner tone="warning" title="Sales channel publishing failed">
                {String(actionData.publicationWarning)}
              </Banner>
            </Layout.Section>
          )}
        {/* Save & View success banner is rendered at the BOTTOM of the page
            so the user sees it after the form they just submitted — see the
            bottom of the Layout for where it lands. */}

        {/* Product Details + Image */}
        <Layout.Section>
          <Card>
            <InlineStack gap="400" wrap={false} blockAlign="start">
              {/* Image - compact left side */}
              <div style={{ width: "120px", minWidth: "120px" }}>
                {imagePreview ? (
                  <BlockStack gap="200" inlineAlign="center">
                    <Thumbnail
                      source={imagePreview}
                      alt="Product image preview"
                      size="large"
                    />
                    <Button
                      variant="plain"
                      tone="critical"
                      size="slim"
                      onClick={handleRemoveImage}
                    >
                      Remove
                    </Button>
                  </BlockStack>
                ) : (
                  <DropZone
                    accept="image/*"
                    type="image"
                    onDrop={handleDropImage}
                    allowMultiple={false}
                  >
                    <BlockStack inlineAlign="center" gap="100">
                      <Icon source={PlusIcon} />
                      <Text as="p" variant="bodySm" alignment="center">Image</Text>
                    </BlockStack>
                  </DropZone>
                )}
              </div>

              {/* Details - right side */}
              <div style={{ flex: 1 }}>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Product Details
                  </Text>
                  <FormLayout>
                    <TextField
                      label="Product Title"
                      value={title}
                      onChange={setTitle}
                      autoComplete="off"
                      requiredIndicator
                    />
                    <InlineStack gap="200" blockAlign="end">
                      <div style={{ flex: 1 }}>
                        <Autocomplete
                          options={vendorOptions}
                          selected={vendor ? [vendor] : []}
                          onSelect={handleVendorSelect}
                          textField={
                            <Autocomplete.TextField
                              label="Vendor"
                              value={vendorInput}
                              onChange={(val: string) => {
                                setVendorInput(val);
                                setVendor(val);
                              }}
                              placeholder="Search or type vendor name..."
                              autoComplete="off"
                              requiredIndicator
                              prefix={<Icon source={SearchIcon} />}
                            />
                          }
                        />
                      </div>
                      <Button
                        onClick={handleRefreshVendors}
                        loading={isRefreshingVendors}
                        disabled={isRefreshingVendors}
                      >
                        Refresh
                      </Button>
                    </InlineStack>
                  </FormLayout>
                </BlockStack>
              </div>
            </InlineStack>
          </Card>
        </Layout.Section>

        {/* Brand & Tagging */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Brand &amp; Tags
              </Text>

              <BlockStack gap="200">
                <Text as="p" variant="bodyMd" fontWeight="semibold">
                  Is this an FLW Branded Item?
                </Text>
                <InlineStack gap="400">
                  <RadioButton
                    label="Yes"
                    checked={isFLWBrand === "yes"}
                    id="flw-brand-yes"
                    onChange={() => {
                      setIsFLWBrand("yes");
                      setHasSeason("");
                      setSelectedSeason("");
                    }}
                  />
                  <RadioButton
                    label="No"
                    checked={isFLWBrand === "no"}
                    id="flw-brand-no"
                    onChange={() => {
                      setIsFLWBrand("no");
                      setIsFLWCore("");
                    }}
                  />
                </InlineStack>
              </BlockStack>

              {isFLWBrand === "yes" && (
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    Consider this an FLW Core Item?
                  </Text>
                  <InlineStack gap="400">
                    <RadioButton
                      label="Yes"
                      checked={isFLWCore === "yes"}
                      id="flw-core-yes"
                      onChange={() => setIsFLWCore("yes")}
                    />
                    <RadioButton
                      label="No"
                      checked={isFLWCore === "no"}
                      id="flw-core-no"
                      onChange={() => setIsFLWCore("no")}
                    />
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    FLW Core items are reviewed monthly for re-ordering.
                  </Text>
                </BlockStack>
              )}

              {isFLWBrand === "no" && (
                <BlockStack gap="200">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    Associate this to a season?
                  </Text>
                  <InlineStack gap="400">
                    <RadioButton
                      label="Yes"
                      checked={hasSeason === "yes"}
                      id="season-yes"
                      onChange={() => setHasSeason("yes")}
                    />
                    <RadioButton
                      label="No"
                      checked={hasSeason === "no"}
                      id="season-no"
                      onChange={() => {
                        setHasSeason("no");
                        setSelectedSeason("");
                      }}
                    />
                  </InlineStack>
                  {hasSeason === "yes" && (
                    <Select
                      label="Season"
                      options={[
                        { label: "Select a season...", value: "" },
                        { label: "Fall/Winter 2025", value: "FW25" },
                        { label: "Spring/Summer 2026", value: "SS26" },
                        { label: "Fall/Winter 2026", value: "FW26" },
                        { label: "Spring/Summer 2027", value: "SS27" },
                        { label: "Fall/Winter 2027", value: "FW27" },
                      ]}
                      value={selectedSeason}
                      onChange={setSelectedSeason}
                    />
                  )}
                </BlockStack>
              )}

              {computedTags.length > 0 && (
                <>
                  <Divider />
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Tags that will be applied:
                    </Text>
                    <InlineStack gap="200">
                      {computedTags.map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </InlineStack>
                  </BlockStack>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Pricing */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Pricing
              </Text>
              <FormLayout>
                <FormLayout.Group>
                  <TextField
                    label="Price"
                    value={price}
                    onChange={setPrice}
                    autoComplete="off"
                    type="number"
                    prefix="$"
                    requiredIndicator
                  />
                  <TextField
                    label="Cost per item"
                    value={cost}
                    onChange={setCost}
                    autoComplete="off"
                    type="number"
                    prefix="$"
                  />
                </FormLayout.Group>
                <TextField
                  label="SKU Prefix"
                  value={skuPrefix}
                  onChange={setSkuPrefix}
                  autoComplete="off"
                  placeholder="e.g., FLW-VENDOR"
                  helpText="Auto-generates SKUs like PREFIX-VALUE1-VALUE2"
                />
              </FormLayout>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Variant Options */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Variant Options
                </Text>
                <Button onClick={handleAddOption} icon={PlusIcon} size="slim">
                  Add Option
                </Button>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                None are required. Add Size, Color, Material, or any custom
                option.
              </Text>

              {options.map((option) => {
                const suggested = getSuggestedValues(option.name);
                const unusedSuggested = suggested.filter(
                  (s) => !option.values.includes(s),
                );

                return (
                  <Card key={option.id}>
                    <BlockStack gap="300">
                      <InlineStack
                        align="space-between"
                        blockAlign="center"
                      >
                        <div style={{ flex: 1, maxWidth: "250px" }}>
                          <TextField
                            label="Option name"
                            value={option.name}
                            onChange={(val: string) =>
                              handleOptionNameChange(option.id, val)
                            }
                            autoComplete="off"
                            placeholder="e.g., Size, Color, Material"
                          />
                        </div>
                        <InlineStack gap="200" blockAlign="center">
                          {option.name === "Size" && (
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="span" variant="bodySm" tone="subdued">
                                Prefill:
                              </Text>
                              <ButtonGroup>
                                <Button
                                  size="slim"
                                  onClick={handleFillMens}
                                >
                                  Men&apos;s
                                </Button>
                                <Button
                                  size="slim"
                                  onClick={handleFillWomens}
                                >
                                  Women&apos;s
                                </Button>
                              </ButtonGroup>
                            </InlineStack>
                          )}
                          <Button
                            icon={DeleteIcon}
                            variant="plain"
                            tone="critical"
                            onClick={() => handleRemoveOption(option.id)}
                            accessibilityLabel="Remove option"
                          />
                        </InlineStack>
                      </InlineStack>

                      <InlineStack gap="200" blockAlign="end">
                        <div style={{ flexGrow: 1 }}>
                          <TextField
                            label="Add value"
                            labelHidden
                            value={option.newValue}
                            onChange={(val: string) =>
                              handleNewValueChange(option.id, val)
                            }
                            autoComplete="off"
                            placeholder={`Add ${option.name || "option"} value...`}
                            connectedRight={
                              <Button
                                onClick={() => handleAddValue(option.id)}
                              >
                                Add
                              </Button>
                            }
                          />
                        </div>
                      </InlineStack>

                      {/* Existing values from store */}
                      {unusedSuggested.length > 0 && (
                        <BlockStack gap="200">
                          <Text as="p" variant="bodySm" tone="subdued">
                            Existing {option.name.toLowerCase()} values in
                            your store:
                          </Text>
                          <InlineStack gap="100" wrap>
                            {unusedSuggested.slice(0, 20).map((val) => (
                              <Button
                                key={val}
                                size="slim"
                                onClick={() =>
                                  handleAddExistingValue(option.id, val)
                                }
                              >
                                + {val}
                              </Button>
                            ))}
                          </InlineStack>
                        </BlockStack>
                      )}

                      {option.values.length > 0 && (
                        <InlineStack gap="200" wrap>
                          {option.values.map((value) => (
                            <Tag
                              key={value}
                              onRemove={() =>
                                handleRemoveValue(option.id, value)
                              }
                            >
                              {value}
                            </Tag>
                          ))}
                        </InlineStack>
                      )}
                    </BlockStack>
                  </Card>
                );
              })}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Metafields */}
        {visibleMetafieldDefs.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Metafields
                  </Text>
                  <Button
                    onClick={handleRefreshMetafields}
                    loading={isRefreshingVendors}
                    disabled={isRefreshingVendors}
                    size="slim"
                  >
                    Refresh
                  </Button>
                </InlineStack>
                <FormLayout>
                  {visibleMetafieldDefs.map((def) => {
                    const metaKey = `${def.namespace}.${def.key}`;
                    const mfType = def.type;

                    // Weight fields (e.g., weight)
                    if (mfType === "weight") {
                      const parsed = metafieldValues[metaKey] ? (() => { try { return JSON.parse(metafieldValues[metaKey]); } catch { return { value: "", unit: "kg" }; } })() : { value: "", unit: "kg" };
                      return (
                        <FormLayout.Group key={metaKey}>
                          <TextField
                            label={def.name}
                            value={String(parsed.value || "")}
                            onChange={(val: string) =>
                              handleMetafieldChange(metaKey, JSON.stringify({ value: parseFloat(val) || 0, unit: parsed.unit || "kg" }))
                            }
                            autoComplete="off"
                            type="number"
                            helpText={def.description || `${def.namespace}.${def.key}`}
                          />
                          <Select
                            label="Unit"
                            options={[
                              { label: "kg", value: "kg" },
                              { label: "g", value: "g" },
                              { label: "lb", value: "lb" },
                              { label: "oz", value: "oz" },
                            ]}
                            value={parsed.unit || "kg"}
                            onChange={(unit: string) =>
                              handleMetafieldChange(metaKey, JSON.stringify({ value: parsed.value || 0, unit }))
                            }
                          />
                        </FormLayout.Group>
                      );
                    }

                    // Dimension fields
                    if (mfType === "dimension") {
                      const parsed = metafieldValues[metaKey] ? (() => { try { return JSON.parse(metafieldValues[metaKey]); } catch { return { value: "", unit: "in" }; } })() : { value: "", unit: "in" };
                      return (
                        <FormLayout.Group key={metaKey}>
                          <TextField
                            label={def.name}
                            value={String(parsed.value || "")}
                            onChange={(val: string) =>
                              handleMetafieldChange(metaKey, JSON.stringify({ value: parseFloat(val) || 0, unit: parsed.unit || "in" }))
                            }
                            autoComplete="off"
                            type="number"
                            helpText={def.description || `${def.namespace}.${def.key}`}
                          />
                          <Select
                            label="Unit"
                            options={[
                              { label: "in", value: "in" },
                              { label: "ft", value: "ft" },
                              { label: "cm", value: "cm" },
                              { label: "m", value: "m" },
                              { label: "mm", value: "mm" },
                            ]}
                            value={parsed.unit || "in"}
                            onChange={(unit: string) =>
                              handleMetafieldChange(metaKey, JSON.stringify({ value: parsed.value || 0, unit }))
                            }
                          />
                        </FormLayout.Group>
                      );
                    }

                    // Volume fields
                    if (mfType === "volume") {
                      const parsed = metafieldValues[metaKey] ? (() => { try { return JSON.parse(metafieldValues[metaKey]); } catch { return { value: "", unit: "ml" }; } })() : { value: "", unit: "ml" };
                      return (
                        <FormLayout.Group key={metaKey}>
                          <TextField
                            label={def.name}
                            value={String(parsed.value || "")}
                            onChange={(val: string) =>
                              handleMetafieldChange(metaKey, JSON.stringify({ value: parseFloat(val) || 0, unit: parsed.unit || "ml" }))
                            }
                            autoComplete="off"
                            type="number"
                            helpText={def.description || `${def.namespace}.${def.key}`}
                          />
                          <Select
                            label="Unit"
                            options={[
                              { label: "ml", value: "ml" },
                              { label: "L", value: "l" },
                              { label: "fl oz", value: "us_fl_oz" },
                              { label: "gal", value: "us_gal" },
                            ]}
                            value={parsed.unit || "ml"}
                            onChange={(unit: string) =>
                              handleMetafieldChange(metaKey, JSON.stringify({ value: parsed.value || 0, unit }))
                            }
                          />
                        </FormLayout.Group>
                      );
                    }

                    // Boolean fields
                    if (mfType === "boolean") {
                      return (
                        <Checkbox
                          key={metaKey}
                          label={def.name}
                          checked={metafieldValues[metaKey] === "true"}
                          onChange={(checked: boolean) =>
                            handleMetafieldChange(metaKey, String(checked))
                          }
                          helpText={def.description || `${def.namespace}.${def.key}`}
                        />
                      );
                    }

                    // File reference fields (e.g. cutting ticket). Supports
                    // both single `file_reference` and `list.file_reference`.
                    // Uploads go through staged upload → fileCreate; the
                    // resulting file gid (or JSON array of gids for list) is
                    // what lands in the metafield value.
                    if (
                      mfType === "file_reference" ||
                      mfType === "list.file_reference"
                    ) {
                      const isList = mfType === "list.file_reference";
                      const files = metafieldFiles[metaKey] ?? [];
                      const anyUploading = files.some((f) => f.uploading);
                      // The per-metafield hint sits next to the affected
                      // field; the global `anyMetafieldUploading` flag on
                      // the Save buttons is the actual submit guard.
                      return (
                        <BlockStack key={metaKey} gap="200">
                          <Text as="p" variant="bodyMd" fontWeight="medium">
                            {def.name}
                          </Text>
                          {def.description && (
                            <Text as="p" variant="bodySm" tone="subdued">
                              {def.description}
                            </Text>
                          )}
                          {/* Hide the dropzone for single-file types once a
                              file is attached — user has to remove before
                              replacing, matching the hero-image pattern. */}
                          {(isList || files.length === 0) && (
                            <DropZone
                              onDrop={(_d, accepted) =>
                                handleDropMetafieldFiles(
                                  metaKey,
                                  isList,
                                  accepted,
                                )
                              }
                              allowMultiple={isList}
                            >
                              <DropZone.FileUpload
                                actionTitle={
                                  isList ? "Add files" : "Add file"
                                }
                                actionHint={
                                  isList
                                    ? "Drop files here or click to upload"
                                    : "Drop a file here or click to upload"
                                }
                              />
                            </DropZone>
                          )}
                          {files.length > 0 && (
                            <BlockStack gap="100">
                              {files.map((f) => (
                                <InlineStack
                                  key={f.id}
                                  align="space-between"
                                  blockAlign="center"
                                  gap="200"
                                >
                                  <BlockStack gap="050">
                                    <Text as="span" variant="bodySm">
                                      {f.name}
                                    </Text>
                                    {f.uploading && (
                                      <Text
                                        as="span"
                                        variant="bodySm"
                                        tone="subdued"
                                      >
                                        Uploading…
                                      </Text>
                                    )}
                                    {f.error && (
                                      <Text
                                        as="span"
                                        variant="bodySm"
                                        tone="critical"
                                      >
                                        {f.error}
                                      </Text>
                                    )}
                                  </BlockStack>
                                  <Button
                                    variant="plain"
                                    tone="critical"
                                    size="slim"
                                    onClick={() =>
                                      handleRemoveMetafieldFile(
                                        metaKey,
                                        isList,
                                        f.id,
                                      )
                                    }
                                  >
                                    Remove
                                  </Button>
                                </InlineStack>
                              ))}
                            </BlockStack>
                          )}
                          {anyUploading && (
                            <Text as="p" variant="bodySm" tone="subdued">
                              Wait for uploads to finish before saving.
                            </Text>
                          )}
                        </BlockStack>
                      );
                    }

                    // Number fields (integer / decimal)
                    if (mfType === "number_integer" || mfType === "number_decimal") {
                      return (
                        <TextField
                          key={metaKey}
                          label={def.name}
                          value={metafieldValues[metaKey] || ""}
                          onChange={(val: string) =>
                            handleMetafieldChange(metaKey, val)
                          }
                          autoComplete="off"
                          type="number"
                          helpText={
                            def.description ||
                            `${def.namespace}.${def.key} (${mfType})`
                          }
                        />
                      );
                    }

                    // Default: text fields (single_line_text_field, multi_line_text_field, url, etc.)
                    return (
                      <TextField
                        key={metaKey}
                        label={def.name}
                        value={metafieldValues[metaKey] || ""}
                        onChange={(val: string) =>
                          handleMetafieldChange(metaKey, val)
                        }
                        autoComplete="off"
                        multiline={mfType === "multi_line_text_field" ? 3 : undefined}
                        helpText={
                          def.description ||
                          `${def.namespace}.${def.key} (${mfType})`
                        }
                      />
                    );
                  })}
                </FormLayout>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Sales Channels */}
        {publications.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Sales Channels
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Select which channels this product will be published to.
                </Text>
                {publications.map((pub) => (
                  <Checkbox
                    key={pub.id}
                    label={pub.name}
                    checked={selectedPubs.includes(pub.id)}
                    onChange={() => handleTogglePub(pub.id)}
                  />
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Starting Inventory (optional toggle) */}
        {locations.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text as="h2" variant="headingMd">
                      Set starting inventory?
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Optional. If skipped, all variants start at 0 units at
                      every location.
                    </Text>
                  </BlockStack>
                  <ButtonGroup variant="segmented">
                    <Button
                      pressed={!setStartingInventory}
                      onClick={() => setSetStartingInventory(false)}
                      size="slim"
                    >
                      No
                    </Button>
                    <Button
                      pressed={setStartingInventory}
                      onClick={() => setSetStartingInventory(true)}
                      size="slim"
                    >
                      Yes
                    </Button>
                  </ButtonGroup>
                </InlineStack>

                {setStartingInventory && variantPreview.length > 0 && (
                  <>
                    <Divider />
                    <BlockStack gap="300">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Enter starting quantities per variant. Blank or 0 =
                        no inventory added.
                      </Text>
                      <div style={{ overflowX: "auto" }}>
                        <table
                          style={{
                            width: "100%",
                            borderCollapse: "collapse",
                            fontSize: "13px",
                          }}
                        >
                          <thead>
                            <tr style={{ borderBottom: "2px solid #e1e3e5" }}>
                              <th
                                style={{ padding: "6px 8px", textAlign: "left" }}
                              >
                                Variant
                              </th>
                              {locations.map((loc) => (
                                <th
                                  key={loc.id}
                                  style={{
                                    padding: "6px 8px",
                                    textAlign: "center",
                                    minWidth: "80px",
                                  }}
                                >
                                  {loc.name}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {variantPreview.map((row) => {
                              // row = [optVal1, optVal2, ..., sku, price]
                              const optValues = row.slice(
                                0,
                                row.length - 2,
                              );
                              const variantKey = optValues.join("/");
                              const sku = row[row.length - 2];
                              return (
                                <tr
                                  key={variantKey}
                                  style={{
                                    borderBottom: "1px solid #f1f1f1",
                                  }}
                                >
                                  <td style={{ padding: "6px 8px" }}>
                                    {optValues.join(" / ") || "(default)"}
                                    {sku && (
                                      <Text
                                        as="span"
                                        variant="bodySm"
                                        tone="subdued"
                                      >
                                        {" "}
                                        · {sku}
                                      </Text>
                                    )}
                                  </td>
                                  {locations.map((loc) => {
                                    const qty =
                                      startingInventory[variantKey]?.[
                                        loc.id
                                      ] ?? 0;
                                    return (
                                      <td
                                        key={loc.id}
                                        style={{ padding: "2px 4px" }}
                                      >
                                        <TextField
                                          label="Qty"
                                          labelHidden
                                          type="number"
                                          value={String(qty)}
                                          onChange={(val: string) => {
                                            const n = Math.max(
                                              0,
                                              parseInt(val, 10) || 0,
                                            );
                                            setStartingInventory_((prev) => ({
                                              ...prev,
                                              [variantKey]: {
                                                ...(prev[variantKey] ?? {}),
                                                [loc.id]: n,
                                              },
                                            }));
                                          }}
                                          autoComplete="off"
                                          min={0}
                                        />
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </BlockStack>
                  </>
                )}
                {setStartingInventory && variantPreview.length === 0 && (
                  <Banner tone="info">
                    Add at least one variant option (e.g. Size) before setting
                    starting inventory.
                  </Banner>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Variant Preview */}
        {variantPreview.length > 0 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Variant Preview ({variantPreview.length} variant
                  {variantPreview.length !== 1 ? "s" : ""})
                </Text>
                <DataTable
                  columnContentTypes={previewContentTypes}
                  headings={previewHeadings}
                  rows={variantPreview}
                />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* Actions */}
        <Layout.Section>
          <InlineStack align="end" gap="200">
            <Button
              onClick={() => handleSubmit("saveAndNew")}
              loading={isSubmitting}
              disabled={
                !title ||
                !effectiveVendor ||
                !price ||
                anyMetafieldUploading
              }
            >
              Save &amp; Create Another
            </Button>
            <Button
              variant="primary"
              onClick={() => handleSubmit("saveAndOpen")}
              loading={isSubmitting}
              disabled={
                !title ||
                !effectiveVendor ||
                !price ||
                anyMetafieldUploading
              }
            >
              Save &amp; View Product
            </Button>
          </InlineStack>
        </Layout.Section>

        {/* Save & View success banner lives at the BOTTOM of the page so
            it appears right where the user's eye is after clicking Save. */}
        {actionData &&
          "success" in actionData &&
          actionData.intent === "saveAndOpen" && (
            <Layout.Section>
              <Banner
                tone="success"
                title={`Product &ldquo;${String(actionData.title)}&rdquo; created with ${Number(
                  actionData.variantCount,
                )} variant${Number(actionData.variantCount) !== 1 ? "s" : ""}`}
                action={
                  actionData.productNumericId
                    ? {
                        content: "View product in Shopify",
                        url: `shopify:admin/products/${actionData.productNumericId}`,
                      }
                    : undefined
                }
                secondaryAction={{
                  content: "Create another product",
                  onAction: resetForm,
                }}
              >
                <p>
                  Use &ldquo;View product&rdquo; to open the Shopify admin,
                  or &ldquo;Create another&rdquo; to clear the form and
                  start a new one.
                </p>
              </Banner>
            </Layout.Section>
          )}

        {/* Bottom spacer */}
        <Layout.Section>
          <div style={{ height: "2rem" }} />
        </Layout.Section>
      </Layout>

      <Modal
        open={addVendorModalOpen}
        onClose={() => {
          setAddVendorModalOpen(false);
          setNewVendorName("");
        }}
        title="Add New Vendor"
        primaryAction={{
          content: "Add Vendor",
          onAction: handleAddVendorConfirm,
          disabled: !newVendorName.trim(),
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: () => {
              setAddVendorModalOpen(false);
              setNewVendorName("");
            },
          },
        ]}
      >
        <Modal.Section>
          <TextField
            label="Vendor Name"
            value={newVendorName}
            onChange={setNewVendorName}
            autoComplete="off"
            placeholder="Enter vendor name..."
            requiredIndicator
          />
        </Modal.Section>
      </Modal>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  let message = "Unknown error";
  let details = "";
  if (isRouteErrorResponse(error)) {
    message = `${error.status} ${error.statusText}`;
    details =
      typeof error.data === "string" ? error.data : JSON.stringify(error.data);
  } else if (error instanceof Error) {
    message = error.message;
    details = error.stack || "";
  }
  return (
    <Page title="Product Builder - Error">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd" tone="critical">
                Something went wrong
              </Text>
              <Text as="p">{message}</Text>
              {details && (
                <Text as="p" variant="bodySm" tone="subdued">
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                    }}
                  >
                    {details}
                  </pre>
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
