---
title: 'K8S中为什么需要Unstructured对象'
date: 2021-12-15T15:33:54Z
draft: false
tags:
  - k8s
categories:
  - cloud
---

熟悉 client-go 的同学都知道，不止有`Deployment`、`Pod`这些结构化对象，也提供了`unstructured.Unstructured`对象，那么为什么需要非结构对象？

## Structured vs Unstructured

结构化对象是指可以用 Go Struct 表示的对象，比如[Deployment](https://pkg.go.dev/k8s.io/api/apps/v1#Deployment)在`k8s.io/api/apps/v1`定义

```go
type Deployment struct {
	metav1.TypeMeta `json:",inline"`
	// Standard object's metadata.
	// More info: https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitempty" protobuf:"bytes,1,opt,name=metadata"`
    ...
}
```

我们可以直接通过`appsv1.Deployment`来安全地定义`Deployment`的各个字段，通常创建过程如下：

```go
clientset, err := kubernetes.NewForConfig(config)

deployment := &appsv1.Deployment{}
deployment.Name = "example"
deployment.Spec = appsv1.DeploymentSpec{
	...
}

clientset.AppsV1().Deployments(apiv1.NamespaceDefault).Create(deployment)
```

而对于`Unstructured`定义在`k8s.io/apimachinery/pkg/apis/meta/v1/unstructured`中

```go
type Unstructured struct {
	// Object is a JSON compatible map with string, float, int, bool, []interface{}, or
	// map[string]interface{}
	// children.
	Object map[string]interface{}
}
```

通过定义`map[string]interface{}`可以来表示任意的`JSON/YAML`对象，而不需要引用`Go Struct`。可以通过`Dynamic client`来创建非结构化对象，以下是使用`Unstructured`创建 Deployment 的样例。

```go
client, _ := dynamic.NewForConfig(config)
deploymentRes := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}

deployment := &unstructured.Unstructured{
	Object: map[string]interface{}{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]interface{}{
			"name": "demo-deployment",
		},
		"spec": map[string]interface{}{
			"replicas": 2,
			...
		}
	}
}

client.Resource(deploymentRes).Namespace(namespace).Create(context.TODO(), deployment, metav1.CreateOptions{})
```

## Why

那么什么情况下需要使用到`Unstructured`对象呢，结构化对象有着安全地类型校验，通过`clientset`可以方便地增删改查。而非结构化对象只能手动设置`GVR`、通过`map[string]interface{}`设置各个字段。

假想你作为一个 Paas 平台的开发者，需要为每个用户传入的`YAML/JSON`资源添加 label，比如添加 user 信息`creator=xxx`。如果用户只能创建 Deployment，那么我们可以将资源解析成`appsv1.Deployment{}`对象，再添加 label。但是通常会传入多种资源，不仅有内置的`Deployment`、`Service`等，也可能会包含自定义资源。由于不确定资源类型，我们只能通过`Unstructured`对象来解析。

```go
const manifest = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: example
spec:
  ...
`
// convert yaml to unstructured
obj := &unstructured.Unstructured{}
dec := yaml.NewDecodingSerializer(unstructured.UnstructuredJSONScheme)
dec.Decode([]byte(manifest), nil, obj)

// add label
labels := obj.GetLabels()
labels["creator"]="userxxx"

// set label
obj.SetLabels(labels)

dynamicClient.Resource().Namespace(namespace).Create(context.TODO(), obj, metav1.CreateOptions{})
```

当实现对多种资源的通用处理（上面的示例），或者运行时才能确定的对象（例如根据配置监听不同对象），又或者不愿引入额外的依赖（处理大量的 CRD），可以使用`Unstructured`对象来处理以上情况。

## How

不管是结构化对象还是非结构化，最终会调用 k8s 的 Rest API，例如`Create Deployment`时

```
POST /apis/apps/v1/namespaces/{namespace}/deployments/{name}
```

K8s 中`GVR`(GroupVersionResource)可以唯一表征资源对象，用来组成 Rest API, 如上 Group 为 apps、Version 为 v1、Resource 是`deployments`；`GVK`(GroupVersionKind)可以来标识类型（如 Deployment）。Resource 与 Kind 的对应关系可以通过`kubectl api-resources`查看。

```bash
~ kubectl api-resources --api-group apps
NAME                  SHORTNAMES   APIVERSION   NAMESPACED   KIND
controllerrevisions                apps/v1      true         ControllerRevision
daemonsets            ds           apps/v1      true         DaemonSet
deployments           deploy       apps/v1      true         Deployment
replicasets           rs           apps/v1      true         ReplicaSet
statefulsets          sts          apps/v1      true         StatefulSet
```

对于结构化对象，使用`clientset`可以获取到`GVR`，最后调用`restClient`组成到 Rest API

```go
clientset.AppsV1().Deployments(namespace).Create(deployment)

// Create takes the representation of a deployment and creates it.  Returns the server's representation of the deployment, and an error, if there is any.
func (c *deployments) Create(ctx context.Context, deployment *v1.Deployment, opts metav1.CreateOptions) (result *v1.Deployment, err error) {
	result = &v1.Deployment{}
	err = c.client.Post().
		Namespace(c.ns).
		Resource("deployments"). // Resource设置
		VersionedParams(&opts, scheme.ParameterCodec).
		Body(deployment).
		Do(ctx).
		Into(result)
	return
}
```

对于非结构化对象，需要用户手动填充`GVR`，如果只知道`GVK`可以通过`restMapping`获取

```go
deploymentRes := schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}

dynamicClient.Resource().Namespace(namespace).Create()

// Create具体实现
func (c *dynamicResourceClient) Create(ctx context.Context, obj *unstructured.Unstructured, opts metav1.CreateOptions, subresources ...string) (*unstructured.Unstructured, error) {
	outBytes, err := runtime.Encode(unstructured.UnstructuredJSONScheme, obj)
	name := ""
	if len(subresources) > 0 {
		accessor, err := meta.Accessor(obj)
		name = accessor.GetName()
	}

    // 调用restClient
	result := c.client.client.
		Post().
		AbsPath(append(c.makeURLSegments(name), subresources...)...).
		Body(outBytes).
		SpecificallyVersionedParams(&opts, dynamicParameterCodec, versionV1).
		Do(ctx)
	// ...
}
```

## 总结

本文描述 Unstructured 对象在 K8s 中的使用场景、使用方式，与 Structured 对象的对比，以及相关代码解析。

## 引用

- https://kubernetes.io/zh/docs/reference/using-api/api-concepts/
