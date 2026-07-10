import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import type {
  PromptSettings,
  ProviderCapabilities,
  ReferenceImageSnapshot,
  SourceImageAsset,
  SourceImageGenerateRequest,
  SourceImageTaskStatus,
} from "../../core/sourceImage";
import {
  fetchProviders,
  generateSourceImages,
  SourceImageApiError,
} from "../../infrastructure/api/sourceImageApi";
import {
  defaultPromptSettings,
  loadPromptSettings,
  savePromptSettings as persistPromptSettings,
} from "../../infrastructure/storage/promptSettingsStorage";
import {
  deleteSourceImage,
  listSourceImages,
  saveSourceImage,
} from "../../infrastructure/storage/sourceImageRepository";
import { getImageDimensions, nearestAspectRatio, referenceImageDataUrl } from "./imageFile";

const CURRENT_SOURCE_KEY = "gif-craft.current-source-image-id";

interface SourceImageContextValue {
  providers: ProviderCapabilities[];
  providersLoading: boolean;
  refreshProviders: () => Promise<void>;
  history: SourceImageAsset[];
  currentSourceId: string | null;
  taskStatus: SourceImageTaskStatus;
  taskError: string;
  promptSettings: PromptSettings;
  updatePromptSettings: (settings: PromptSettings) => void;
  resetPromptSettings: () => void;
  generate: (request: SourceImageGenerateRequest) => Promise<void>;
  addLocalImage: (image: ReferenceImageSnapshot) => Promise<void>;
  confirmSource: (id: string) => void;
  removeSourceImage: (id: string) => Promise<void>;
  clearTaskError: () => void;
}

const SourceImageContext = createContext<SourceImageContextValue | null>(null);

export function SourceImageProvider({ children }: PropsWithChildren) {
  const [providers, setProviders] = useState<ProviderCapabilities[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [history, setHistory] = useState<SourceImageAsset[]>([]);
  const [currentSourceId, setCurrentSourceId] = useState<string | null>(() =>
    localStorage.getItem(CURRENT_SOURCE_KEY),
  );
  const [taskStatus, setTaskStatus] = useState<SourceImageTaskStatus>("idle");
  const [taskError, setTaskError] = useState("");
  const [promptSettings, setPromptSettings] = useState(loadPromptSettings);

  const refreshProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      setProviders(await fetchProviders());
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : "无法读取服务商状态。");
    } finally {
      setProvidersLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProviders();
    void listSourceImages().then(setHistory).catch(() => setHistory([]));
  }, [refreshProviders]);

  const updatePromptSettings = useCallback((settings: PromptSettings) => {
    persistPromptSettings(settings);
    setPromptSettings(settings);
  }, []);

  const resetPromptSettings = useCallback(() => {
    const defaults = defaultPromptSettings();
    persistPromptSettings(defaults);
    setPromptSettings(defaults);
  }, []);

  const generate = useCallback(
    async (request: SourceImageGenerateRequest) => {
      setTaskError("");
      setTaskStatus("validating");
      try {
        setTaskStatus("submitting");
        const result = await generateSourceImages(request);
        setTaskStatus("generating");
        const assets = await Promise.all(
          result.images.map(async (image): Promise<SourceImageAsset> => {
            const dimensions = await getImageDimensions(image.dataUrl).catch(() => ({
              width: image.width,
              height: image.height,
            }));
            return {
              id: image.id,
              jobId: result.jobId,
              provider: result.provider,
              model: result.model,
              mode: request.mode,
              createdAt: new Date().toISOString(),
              dataUrl: image.dataUrl,
              mimeType: image.mimeType,
              width: dimensions.width,
              height: dimensions.height,
              sourceName: request.referenceImage?.name,
              promptSnapshot: {
                userPrompt: request.userPrompt,
                basePrompt: request.basePrompt,
                negativePrompt: request.negativePrompt,
                compiledPrompt: result.compiledPrompt,
                templateVersion: promptSettings.version,
              },
              effectiveParameters: {
                aspectRatio: result.effectiveParameters.aspectRatio,
                quality: result.effectiveParameters.quality,
                providerSize: result.effectiveParameters.providerSize,
              },
              referenceImage: request.referenceImage,
            };
          }),
        );
        await Promise.all(assets.map(saveSourceImage));
        setHistory((current) => [...assets, ...current]);
        setTaskStatus("succeeded");
      } catch (error) {
        const statusUnknown =
          error instanceof SourceImageApiError && error.code === "status_unknown";
        setTaskStatus(statusUnknown ? "status_unknown" : "failed");
        setTaskError(error instanceof Error ? error.message : "生成失败。" );
      }
    },
    [promptSettings.version],
  );

  const addLocalImage = useCallback(
    async (image: ReferenceImageSnapshot) => {
      const asset: SourceImageAsset = {
        id: crypto.randomUUID(),
        jobId: crypto.randomUUID(),
        provider: "local",
        model: "local-upload",
        mode: "local_upload",
        createdAt: new Date().toISOString(),
        dataUrl: referenceImageDataUrl(image),
        mimeType: image.mimeType,
        width: image.width,
        height: image.height,
        sourceName: image.name,
        promptSnapshot: {
          userPrompt: "",
          basePrompt: "",
          negativePrompt: "",
          compiledPrompt: "",
          templateVersion: promptSettings.version,
        },
        effectiveParameters: {
          aspectRatio: nearestAspectRatio(image.width, image.height),
          quality: "standard",
          providerSize: `${image.width}x${image.height}`,
        },
        referenceImage: image,
      };
      await saveSourceImage(asset);
      setHistory((current) => [asset, ...current]);
      setTaskStatus("succeeded");
      setTaskError("");
    },
    [promptSettings.version],
  );

  const confirmSource = useCallback((id: string) => {
    localStorage.setItem(CURRENT_SOURCE_KEY, id);
    setCurrentSourceId(id);
  }, []);

  const removeSourceImage = useCallback(
    async (id: string) => {
      await deleteSourceImage(id);
      setHistory((current) => current.filter((item) => item.id !== id));
      if (currentSourceId === id) {
        localStorage.removeItem(CURRENT_SOURCE_KEY);
        setCurrentSourceId(null);
      }
    },
    [currentSourceId],
  );

  const value = useMemo<SourceImageContextValue>(
    () => ({
      providers,
      providersLoading,
      refreshProviders,
      history,
      currentSourceId,
      taskStatus,
      taskError,
      promptSettings,
      updatePromptSettings,
      resetPromptSettings,
      generate,
      addLocalImage,
      confirmSource,
      removeSourceImage,
      clearTaskError: () => setTaskError(""),
    }),
    [
      providers,
      providersLoading,
      refreshProviders,
      history,
      currentSourceId,
      taskStatus,
      taskError,
      promptSettings,
      updatePromptSettings,
      resetPromptSettings,
      generate,
      addLocalImage,
      confirmSource,
      removeSourceImage,
    ],
  );

  return <SourceImageContext.Provider value={value}>{children}</SourceImageContext.Provider>;
}

export function useSourceImages(): SourceImageContextValue {
  const context = useContext(SourceImageContext);
  if (!context) throw new Error("useSourceImages must be used inside SourceImageProvider");
  return context;
}
