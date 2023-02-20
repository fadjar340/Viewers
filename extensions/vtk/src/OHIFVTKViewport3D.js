import React from 'react';
import { Component } from 'react';
import { getImageData, loadImageData, View3D } from 'react-vtkjs-viewport';
import ConnectedVTKViewport from './ConnectedVTKViewport';
import LoadingIndicator from './LoadingIndicator.js';
import OHIF from '@ohif/core';
import PropTypes from 'prop-types';
import cornerstone from 'cornerstone-core';
import cornerstoneTools from 'cornerstone-tools';
import vtkDataArray from 'vtk.js/Sources/Common/Core/DataArray';
import vtkImageData from 'vtk.js/Sources/Common/DataModel/ImageData';
import vtkVolume from 'vtk.js/Sources/Rendering/Core/Volume';
import vtkVolumeMapper from 'vtk.js/Sources/Rendering/Core/VolumeMapper';
import vtkColorTransferFunction from 'vtk.js/Sources/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from 'vtk.js/Sources/Common/DataModel/PiecewiseFunction';
import presets from './presets.js';

const segmentationModule = cornerstoneTools.getModule('segmentation');

const { StackManager } = OHIF.utils;

//const SOPInstanceUID = '00080018';
//const SERIES_INSTANCE_UID = '0020000E';

// TODO: Figure out where we plan to put this long term
const volumeCache = {};
const labelmapCache = {};

/**
 * Create a labelmap image with the same dimensions as our background volume.
 *
 * @param backgroundImageData vtkImageData
 */
/* TODO: Not currently used until we have drawing tools in vtkjs.
function createLabelMapImageData(backgroundImageData) {
  // TODO => Need to do something like this if we start drawing a new segmentation
  // On a vtkjs viewport.

  const labelMapData = vtkImageData.newInstance(
    backgroundImageData.get('spacing', 'origin', 'direction')
  );
  labelMapData.setDimensions(backgroundImageData.getDimensions());
  labelMapData.computeTransforms();

  const values = new Uint8Array(backgroundImageData.getNumberOfPoints());
  const dataArray = vtkDataArray.newInstance({
    numberOfComponents: 1, // labelmap with single component
    values,
  });
  labelMapData.getPointData().setScalars(dataArray);

  return labelMapData;
} */

class OHIFVTKViewport3D extends Component {
  state = {
    volumes: null,
    paintFilterLabelMapImageData: null,
    paintFilterBackgroundImageData: null,
    percentComplete: 0,
    isLoaded: true,
    ctTransferFunctionPresetId: 'vtkMRMLVolumePropertyNode4',
    petColorMapId: 'hsv',
  };

  static propTypes = {
    viewportData: PropTypes.shape({
      studies: PropTypes.array.isRequired,
      displaySet: PropTypes.shape({
        StudyInstanceUID: PropTypes.string.isRequired,
        displaySetInstanceUID: PropTypes.string.isRequired,
        sopClassUIDs: PropTypes.arrayOf(PropTypes.string),
        SOPInstanceUID: PropTypes.string,
        SeriesInstanceUID: PropTypes.string,
        imageIds: PropTypes.string,
        frameIndex: PropTypes.number,
      }),
    }),
    viewportIndex: PropTypes.number,
    children: PropTypes.node,
    onScroll: PropTypes.func,
    servicesManager: PropTypes.object,
  };

  static defaultProps = {
    onScroll: () => {},
  };

  static id = 'OHIFVTKViewport3D';

  static init() {
    console.log('OHIFVTKViewport3D init()');
  }

  static destroy() {
    console.log('OHIFVTKViewport3D destroy()');
    StackManager.clearStacks();
  }

  static getCornerstoneStack(
    studies,
    StudyInstanceUID,
    displaySetInstanceUID,
    SOPInstanceUID,
    SeriesInstanceUID,
    imageIds,
    frameIndex
  ) {
    // Create shortcut to displaySet
    const study = studies.find(
      study => study.StudyInstanceUID === StudyInstanceUID
    );

    const displaySet = study.displaySets.find(set => {
      return set.displaySetInstanceUID === displaySetInstanceUID;
    });

    // Get stack from Stack Manager
    const storedStack = StackManager.findOrCreateStack(study, displaySet);

    // Clone the stack here so we don't mutate it
    const stack = Object.assign({}, storedStack);

    if (frameIndex !== undefined) {
      stack.currentImageIdIndex = frameIndex;
    } else if (SOPInstanceUID) {
      const index = stack.imageIds.findIndex(imageId => {
        const imageIdSOPInstanceUID = cornerstone.metaData.get(
          'SOPInstanceUID',
          imageId
        );

        return imageIdSOPInstanceUID === SOPInstanceUID;
      });

      if (index > -1) {
        stack.currentImageIdIndex = index;
      }
    } else if (SeriesInstanceUID) {
      const index = stack.imageIds.findIndex(imageId => {
        const imageIdSeriesInstanceUID = cornerstone.metaData.get(
          'SeriesInstanceUID',
          imageId
        );

        return imageIdSeriesInstanceUID === SeriesInstanceUID;
      });

      if (index > -1) {
        stack.currentImageIdIndex = index;
      }
    }
    else if (imageIds) {
      const index = stack.imageIds.findIndex(imageId => {
        const imageIdimageId = cornerstone.metaData.get(
          imageId
        );

        return imageIdimageId === imageId;
      });

      if (index > -1) {
        stack.currentImageIdIndex = index;
      }
    }
    else {
      stack.currentImageIdIndex = 0;
    }

    return stack;
  }

  getViewportData = (
    studies,
    StudyInstanceUID,
    displaySetInstanceUID,
    SOPClassUID,
    SOPInstanceUID,
    SeriesInstanceUID,
    imageIds,
    frameIndex
  ) => {
    const { UINotificationService } = this.props.servicesManager.services;

    const stack = OHIFVTKViewport3D.getCornerstoneStack(
      studies,
      StudyInstanceUID,
      displaySetInstanceUID,
      SOPClassUID,
      SOPInstanceUID,
      SeriesInstanceUID,
      imageIds,
      frameIndex
    );

    const imageDataObject = getImageData(stack.imageIds, displaySetInstanceUID);
    let labelmapDataObject;
    let labelmapColorLUT;

    const firstImageId = stack.imageIds[0];
    const { state } = segmentationModule;
    const brushStackState = state.series[firstImageId];

    if (brushStackState) {
      const { activeLabelmapIndex } = brushStackState;
      const labelmap3D = brushStackState.labelmaps3D[activeLabelmapIndex];

      if (
        brushStackState.labelmaps3D.length > 1 &&
        this.props.viewportIndex === 0
      ) {
        UINotificationService.show({
          title: 'Overlapping Segmentation Found',
          message:
            'Overlapping segmentations cannot be displayed when in MPR mode',
          type: 'info',
        });
      }

      this.segmentsDefaultProperties = labelmap3D.segmentsHidden.map(
        isHidden => {
          return { visible: !isHidden };
        }
      );

      const vtkLabelmapID = `${firstImageId}_${activeLabelmapIndex}`;

      if (labelmapCache[vtkLabelmapID]) {
        labelmapDataObject = labelmapCache[vtkLabelmapID];
      } else {
        // TODO -> We need an imageId based getter in cornerstoneTools
        const labelmapBuffer = labelmap3D.buffer;

        // Create VTK Image Data with buffer as input
        labelmapDataObject = vtkImageData.newInstance();

        const dataArray = vtkDataArray.newInstance({
          numberOfComponents: 1, // labelmap with single component
          values: new Uint16Array(labelmapBuffer),
        });

        labelmapDataObject.getPointData().setScalars(dataArray);
        labelmapDataObject.setDimensions(...imageDataObject.dimensions);
        labelmapDataObject.setSpacing(
          ...imageDataObject.vtkImageData.getSpacing()
        );
        labelmapDataObject.setOrigin(
          ...imageDataObject.vtkImageData.getOrigin()
        );
        labelmapDataObject.setDirection(
          ...imageDataObject.vtkImageData.getDirection()
        );

        // Cache the labelmap volume.
        labelmapCache[vtkLabelmapID] = labelmapDataObject;
      }

      labelmapColorLUT = state.colorLutTables[labelmap3D.colorLUTIndex];
    }

    return {
      imageDataObject,
      labelmapDataObject,
      labelmapColorLUT,
    };
  };

  /**
   *
   *
   * @param {object} imageDataObject
   * @param {object} imageDataObject.vtkImageData
   * @param {object} imageDataObject.imageMetaData0
   * @param {number} [imageDataObject.imageMetaData0.WindowWidth] - The volume's initial WindowWidth
   * @param {number} [imageDataObject.imageMetaData0.WindowCenter] - The volume's initial WindowCenter
   * @param {string} imageDataObject.imageMetaData0.Modality - CT, MR, PT, etc
   * @param {string} displaySetInstanceUID
   * @returns vtkVolumeActor
   * @memberof OHIFVTKViewport3D
   */
  getOrCreateVolume(imageDataObject, displaySetInstanceUID) {
    if (volumeCache[displaySetInstanceUID]) {
      return volumeCache[displaySetInstanceUID];
    }

    const { vtkImageData, imageMetaData0 } = imageDataObject;
    // TODO -> Should update react-vtkjs-viewport and react-cornerstone-viewports
    // internals to use naturalized DICOM JSON names.
    const {
      windowWidth: WindowWidth,
      windowCenter: WindowCenter,
      modality: Modality,
    } = imageMetaData0;

    const { lower, upper } = _getRangeFromWindowLevels(
      WindowWidth,
      WindowCenter,
      Modality
    );
    const volumeActor = vtkVolume.newInstance();
    const volumeMapper = vtkVolumeMapper.newInstance();

    volumeActor.setMapper(volumeMapper);
    volumeMapper.setInputData(vtkImageData);

    volumeActor
      .getProperty()
      .getRGBTransferFunction(0)
      .setRange(lower, upper);

    const spacing = vtkImageData.getSpacing();
    // Set the sample distance to half the mean length of one side. This is where the divide by 6 comes from.
    // https://github.com/Kitware/VTK/blob/6b559c65bb90614fb02eb6d1b9e3f0fca3fe4b0b/Rendering/VolumeOpenGL2/vtkSmartVolumeMapper.cxx#L344
    const sampleDistance = (spacing[0] + spacing[1] + spacing[2]) / 6;

    volumeMapper.setSampleDistance(sampleDistance);

    // Be generous to suppress warnings, as the logging really hurts performance.
    // TODO: maybe we should auto adjust samples to 1000.
    volumeMapper.setMaximumSamplesPerRay(4000);

    volumeCache[displaySetInstanceUID] = volumeActor;

    return volumeActor;
  }

  getShiftRange(colorTransferArray) {
    // Credit to paraview-glance
    // https://github.com/Kitware/paraview-glance/blob/3fec8eeff31e9c19ad5b6bff8e7159bd745e2ba9/src/components/controls/ColorBy/script.js#L133

    // shift range is original rgb/opacity range centered around 0
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < colorTransferArray.length; i += 4) {
      min = Math.min(min, colorTransferArray[i]);
      max = Math.max(max, colorTransferArray[i]);
    }

    const center = (max - min) / 2;

    return {
      shiftRange: [-center, center],
      min,
      max,
    };
  }

  applyPointsToPiecewiseFunction(points, range, pwf) {
    const width = range[1] - range[0];
    const rescaled = points.map(([x, y]) => [x * width + range[0], y]);

      pwf.removeAllPoints();
      rescaled.forEach(([x, y]) => pwf.addPoint(x, y));

    return rescaled;
  }

  applyPointsToRGBFunction(points, range, cfun) {
    const width = range[1] - range[0];
    const rescaled = points.map(([x, r, g, b]) => [
      x * width + range[0],
      r,
      g,
      b,
    ]);

    cfun.removeAllPoints();
    rescaled.forEach(([x, r, g, b]) => cfun.addRGBPoint(x, r, g, b));

    return rescaled;
  }

  applyPreset(volumeActor, preset) {
    // Create color transfer function
    const colorTransferArray = preset.colorTransfer
      .split(' ')
      .splice(1)
      .map(parseFloat);

    const { shiftRange } = getShiftRange(colorTransferArray);
    let min = shiftRange[0];
    const width = shiftRange[1] - shiftRange[0];
    const cfun = vtkColorTransferFunction.newInstance();
    const normColorTransferValuePoints = [];
    for (let i = 0; i < colorTransferArray.length; i += 4) {
      let value = colorTransferArray[i];
      const r = colorTransferArray[i + 1];
      const g = colorTransferArray[i + 2];
      const b = colorTransferArray[i + 3];

      value = (value - min) / width;
      normColorTransferValuePoints.push([value, r, g, b]);
    }

    applyPointsToRGBFunction(normColorTransferValuePoints, shiftRange, cfun);

    volumeActor.getProperty().setRGBTransferFunction(0, cfun);

    // Create scalar opacity function
    const scalarOpacityArray = preset.scalarOpacity
      .split(' ')
      .splice(1)
      .map(parseFloat);

    const ofun = vtkPiecewiseFunction.newInstance();
    const normPoints = [];
    for (let i = 0; i < scalarOpacityArray.length; i += 2) {
      let value = scalarOpacityArray[i];
      const opacity = scalarOpacityArray[i + 1];

      value = (value - min) / width;

      normPoints.push([value, opacity]);
    }

    applyPointsToPiecewiseFunction(normPoints, shiftRange, ofun);

    volumeActor.getProperty().setScalarOpacity(0, ofun);

    const [
      gradientMinValue,
      gradientMinOpacity,
      gradientMaxValue,
      gradientMaxOpacity,
    ] = preset.gradientOpacity
      .split(' ')
      .splice(1)
      .map(parseFloat);

    volumeActor.getProperty().setUseGradientOpacity(0, true);
    volumeActor.getProperty().setGradientOpacityMinimumValue(0, gradientMinValue);
    volumeActor.getProperty().setGradientOpacityMinimumOpacity(0, gradientMinOpacity);
    volumeActor.getProperty().setGradientOpacityMaximumValue(0, gradientMaxValue);
    volumeActor.getProperty().setGradientOpacityMaximumOpacity(0, gradientMaxOpacity);

    if (preset.interpolation === '1') {
      volumeActor.getProperty().setInterpolationTypeToFastLinear();
      //volumeActor.getProperty().setInterpolationTypeToLinear()
    }

    const ambient = parseFloat(preset.ambient);
    //const shade = preset.shade === '1'
    const diffuse = parseFloat(preset.diffuse);
    const specular = parseFloat(preset.specular);
    const specularPower = parseFloat(preset.specularPower);

    //volumeActor.getProperty().setShade(shade)
    volumeActor.getProperty().setAmbient(ambient);
    volumeActor.getProperty().setDiffuse(diffuse);
    volumeActor.getProperty().setSpecular(specular);
    volumeActor.getProperty().setSpecularPower(specularPower);
  }

  createCT3dPipeline(imageDataObject, ctTransferFunctionPresetId) {
    const { volumeActor, mapper } = createActorMapper(imageDataObject);

    const sampleDistance =
      1.2 *
      Math.sqrt(
        imageDataObject
          .getSpacing()
          .map(v => v * v)
          .reduce((a, b) => a + b, 0)
      );

    const range = imageDataObject
      .getPointData()
      .getScalars()
      .getRange();
    volumeActor
      .getProperty()
      .getRGBTransferFunction(0)
      .setRange(range[0], range[1]);

    mapper.setSampleDistance(sampleDistance);

    const preset = presets.find(
      preset => preset.id === ctTransferFunctionPresetId
    );

    applyPreset(volumeActor, preset);

    volumeActor.getProperty().setScalarOpacityUnitDistance(0, 2.5);

    return volumeActor;
  }

    setStateFromProps() {
      const { studies } = this.getViewportData;
      const {
        StudyInstanceUID,
      displaySetInstanceUID,
      sopClassUIDs,
      SOPInstanceUID,
      SeriesInstanceUID,
      imageIds,
      frameIndex,
    } = displaySet;

    if (sopClassUIDs.length > 1) {
      console.warn(
        'More than one SOPClassUID in the same series is not yet supported.'
      );
    }

    const study = studies.find(
      study => study.StudyInstanceUID === StudyInstanceUID
    );

    const dataDetails = {
      studyDate: study.studyDate,
      studyTime: study.studyTime,
      studyDescription: study.studyDescription,
      patientName: study.patientName,
      patientId: study.patientId,
      seriesNumber: String(displaySet.seriesNumber),
      imageIds: displaySet.imageIds,
      seriesDescription: displaySet.seriesDescription,
    };

    try {
      const {
        imageDataObject,
        labelmapDataObject,
        labelmapColorLUT,
      } = this.getViewportData(
        studies,
        StudyInstanceUID,
        displaySetInstanceUID,
        SOPInstanceUID,
        SeriesInstanceUID,
        imageIds,
        frameIndex
      );

      this.imageDataObject = imageDataObject;

      /* TODO: Not currently used until we have drawing tools in vtkjs.
      if (!labelmap) {
        labelmap = createLabelMapImageData(data);
      } */

      const volumeActor = this.getOrCreateVolume(
        imageDataObject,
        displaySetInstanceUID
      );
      const ctVolVR = createCT3dPipeline(
        volumeActor,
        this.state.ctTransferFunctionPresetId
      );

      this.setStateFromProps(
        {
          percentComplete: 0,
          dataDetails,
        },
        () => {
          this.loadProgressively(imageDataObject);

          // TODO: There must be a better way to do this.
          // We do this so that if all the data is available the react-vtkjs-viewport
          // Will render _something_ before the volumes are set and the volume
          // Construction that happens in react-vtkjs-viewport locks up the CPU.
          setTimeout(() => {
            this.setStateFromProps({
              volumes: [ctVolVR],
              paintFilterLabelMapImageData: labelmapDataObject,
              paintFilterBackgroundImageData: imageDataObject.vtkImageData,
              ctTransferFunctionPresetId,
              petColorMapId,
              labelmapColorLUT,
            });
          }, 200);
        }
      );
    } catch (error) {
      const errorTitle = 'Failed to load 2D MPR';
      console.error(errorTitle, error);
      const {
        UINotificationService,
        LoggerService,
      } = this.props.servicesManager.services;
      if (this.props.viewportIndex === 0) {
        const message = error.message.includes('buffer')
          ? 'Dataset is too big to display in MPR'
          : error.message;
        LoggerService.error({ error, message });
        UINotificationService.show({
          title: errorTitle,
          message,
          type: 'error',
          autoClose: false,
          action: {
            label: 'Exit 3D MPR',
            onClick: ({ close }) => {
              // context: 'ACTIVE_VIEWPORT::VTK',
              close();
              this.props.commandsManager.runCommand('setCornerstoneLayout');
            },
          },
        });
      }
      this.setStateFromProps({ isLoaded: false });
    }
  }

  componentDidMount() {
   this.setStateFromProps();
  }


  handleChangeCTTransferFunction = event => {
    const ctTransferFunctionPresetId = event.target.value;
    const preset = presets.find(
      preset => preset.id === ctTransferFunctionPresetId
    );

    const volumeActor = this.state.volumes[0];

    applyPreset(volumeActor, preset);

    this.rerenderAll();

    this.setStateFromProps({
      ctTransferFunctionPresetId,
    });
  };

  rerenderAll = () => {
    // Update all render windows, since the automatic re-render might not
    // happen if the viewport is not currently using the painting widget
    Object.keys(this.apis).forEach(viewportIndex => {
      const renderWindow = this.apis[
        viewportIndex
      ].genericRenderWindow.getRenderWindow();

      renderWindow.render();
    });
  };

  componentDidUpdate(prevProps, prevState) {
    const { displaySet } = this.props.viewportData;
    const prevDisplaySet = prevProps.viewportData.displaySet;

    if (
      displaySet.displaySetInstanceUID !==
      prevDisplaySet.displaySetInstanceUID ||
      displaySet.SOPInstanceUID !== prevDisplaySet.SOPInstanceUID ||
      displaySet.imageIds !== prevDisplaySet.imageIds ||
      displaySet.frameIndex !== prevDisplaySet.frameIndex
    ) {
      this.setStateFromProps();
    }
  }

  loadProgressively(imageDataObject) {
    loadImageData(imageDataObject);

    const { isLoading, imageIds } = imageDataObject;

    if (!isLoading) {
      this.setState({ isLoaded: false });
      return;
    }

    const NumberOfFrames = imageIds.length;

    const onPixelDataInsertedCallback = numberProcessed => {
      const percentComplete = Math.floor(
        (numberProcessed * 100) / NumberOfFrames
      );

      if (percentComplete !== this.state.percentComplete) {
        this.setState({
          percentComplete,
        });
      }

      if (percentComplete % 20 === 0) {
        this.rerenderAll();
      }
    };

//    const onAllPixelDataInsertedCallback = () => {
//      this.rerenderAll();
//    };

    const onPixelDataInsertedErrorCallback = error => {
      const {
        UINotificationService,
        LoggerService,
      } = this.props.servicesManager.services;

      if (!this.hasError) {
        if (this.props.viewportIndex === 0) {
          // Only show the notification from one viewport 1 in MPR2D.
          LoggerService.error({ error, message: error.message });
          UINotificationService.show({
            title: 'MPR Load Error',
            message: error.message,
            type: 'error',
            autoClose: false,
          });
        }

        this.hasError = true;
      }
    };

    const onAllPixelDataInsertedCallback = () => {
      this.setState({
        isLoaded: true,
      });
    };

    imageDataObject.onPixelDataInserted(onPixelDataInsertedCallback);
    imageDataObject.onAllPixelDataInserted(onAllPixelDataInsertedCallback);
    imageDataObject.onPixelDataInsertedError(onPixelDataInsertedErrorCallback);
  }

  render() {
    let childrenWithProps = null;
    const { configuration } = segmentationModule;

    // TODO: Does it make more sense to use Context?
    if (this.props.children && this.props.children.length) {
      childrenWithProps = this.props.children.map((child, index) => {
        return (
          child &&
          React.cloneElement(child, {
            viewportIndex: this.props.viewportIndex,
            key: index,
          })
        );
      });
    }

    const style = { width: '100%', height: '100%', position: 'relative' };

    const ctTransferFunctionPresetOptions = presets.map(preset => {
      return (
        <option key={preset.id} value={preset.id}>
          {preset.name}
        </option>
      );
    });

    const { percentComplete } = this.state;

    const progressString = `Progress: ${percentComplete}%`;

   return (
    <div style={style}>
    {!this.state.isLoaded && (
      <LoadingIndicator percentComplete={this.state.percentComplete} />
    )}
    {this.state.volumes && (
      <ConnectedVTKViewport
        volumes={this.state.volumes}
        paintFilterLabelMapImageData={
          this.state.paintFilterLabelMapImageData
        }
        paintFilterBackgroundImageData={
          this.state.paintFilterBackgroundImageData
        }
        viewportIndex={this.props.viewportIndex}
        dataDetails={this.state.dataDetails}
        labelmapRenderingOptions={{
          colorLUT: this.state.labelmapColorLUT,
          globalOpacity: configuration.fillAlpha,
          visible: configuration.renderFill,
          outlineThickness: configuration.outlineWidth,
          renderOutline: configuration.renderOutline,
          segmentsDefaultProperties: this.segmentsDefaultProperties,
          onNewSegmentationRequested: () => {
            this.setStateFromProps();
          },
        }}
        onScroll={this.props.onScroll}
        />
        )}
          <div className="row">
          <div className="col-xs-12">
            <div>
              <select
                id="select_CT_xfer_fn"
                value={this.state.ctTransferFunctionPresetId}
                onChange={this.handleChangeCTTransferFunction}
              >
                {ctTransferFunctionPresetOptions}
              </select>
            </div>
          </div>
          <div className="col-xs-12 col-sm-6">
            <View3D 
              volumes={this.state.volumes}
              //onCreated={this.saveApiReference}
            />
          </div>
        </div>
      </div>
      );
    }

}

/**
 * Takes window levels and converts them to a range (lower/upper)
 * for use with VTK RGBTransferFunction
 *
 * @private
 * @param {number} [width] - the width of our window
 * @param {number} [center] - the center of our window
 * @param {string} [Modality] - 'PT', 'CT', etc.
 * @returns { lower, upper } - range
 */
function _getRangeFromWindowLevels(width, center, Modality = undefined) {
  // For PET just set the range to 0-5 SUV
  if (Modality === 'PT') {
    return { lower: 0, upper: 5 };
  }

  const levelsAreNotNumbers = isNaN(center) || isNaN(width);

  if (levelsAreNotNumbers) {
    return { lower: 0, upper: 512 };
  }

  return {
    lower: center - width / 2.0,
    upper: center + width / 2.0,
  };
 }


export default OHIFVTKViewport3D;
