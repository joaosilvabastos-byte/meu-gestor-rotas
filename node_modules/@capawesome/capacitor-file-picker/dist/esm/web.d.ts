import { WebPlugin } from '@capacitor/core';
import type { ConvertHeicToJpegOptions, ConvertHeicToJpegResult, FilePickerPlugin, PermissionStatus, PickFilesOptions, PickFilesResult, PickImagesOptions, PickImagesResult, PickMediaOptions, PickMediaResult, PickVideosOptions, PickVideosResult, RequestPermissionsOptions, PickDirectoryResult } from './definitions';
export declare class FilePickerWeb extends WebPlugin implements FilePickerPlugin {
    readonly ERROR_PICK_FILE_CANCELED = "pickFiles canceled.";
    checkPermissions(): Promise<PermissionStatus>;
    convertHeicToJpeg(_options: ConvertHeicToJpegOptions): Promise<ConvertHeicToJpegResult>;
    pickFiles(options?: PickFilesOptions): Promise<PickFilesResult>;
    pickDirectory(): Promise<PickDirectoryResult>;
    pickImages(options?: PickImagesOptions): Promise<PickImagesResult>;
    pickMedia(options?: PickMediaOptions): Promise<PickMediaResult>;
    pickVideos(options?: PickVideosOptions): Promise<PickVideosResult>;
    requestPermissions(_options?: RequestPermissionsOptions): Promise<PermissionStatus>;
    private openFilePicker;
    private getDataFromFile;
    private getNameFromUrl;
    private getMimeTypeFromUrl;
    private getSizeFromUrl;
    private wait;
}
